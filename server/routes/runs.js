// Runs: transcript, terminal, intervention and permission answers. Mounted by server/index.js behind the owner cookie check.
import express from 'express'
import { existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { get, update, getProject, setTask, log } from '../db.js'
import { emit } from '../bus.js'
import { killRun, sendToRun, interruptRun, resumeRun, handoffRun, answerPermission, getRunEvents, watchPty, ptyInput, ptyResize, ptyLogPath } from '../runner.js'
import { rememberPattern } from '../rules.js'
import { fail, int, found, str, regex } from '../http.js'

const app = express.Router()
export default app

// "Allow, don't ask again": checked before the answer so a refused pattern leaves the request open for a plain Allow.
export function answer(run_id, request_id, allow, { message, remember } = {}) {
  let add
  if (allow && remember) {
    const r = found(get('SELECT project_id, pending_permission FROM runs WHERE id = ?', run_id), 'run')
    const req = found((r.pending_permission || []).find(x => x.request_id === request_id), 'permission request')
    if (req.tool_name !== 'Bash') throw fail(400, 'Only shell commands can be remembered')
    add = rememberPattern(req.input?.command)
    if (add.error) throw fail(400, add.error)
    add.project = getProject(r.project_id)
  }
  answerPermission(run_id, request_id, allow, { message })
  if (!add) return
  const s = add.project.settings, re = `${s.auto_allow_bash}|${add.pattern}`
  if (new RegExp(s.auto_allow_bash).test(add.prefix) || !regex(re)) return
  update('projects', add.project.id, { settings: { ...s, auto_allow_bash: re } })
  emit('project', add.project.id, getProject(add.project.id))
  log(add.project.id, 'settings', `"${add.prefix}" no longer asks for permission`)
}

// Runs: live transcript and intervention

const runRow = req => found(get('SELECT * FROM runs WHERE id = ?', int(req.params.id)), 'run')

app.get('/api/runs/:id', (req, res) => res.json(runRow(req)))

app.get('/api/runs/:id/events', (req, res) => {
  const r = runRow(req), { after, tail } = req.query
  res.json(getRunEvents(r.id, tail ? { tail: Math.min(int(tail), 500) } : { after: after ? Number(after) || 0 : 0 }))
})

// Last bytes of a finished terminal run, for replay.
function ptyTail(run_id, max = 1024 * 1024) {
  const p = ptyLogPath(run_id)
  if (!existsSync(p)) return ''
  const fd = openSync(p, 'r')
  try {
    const size = fstatSync(fd).size, n = Math.min(size, max)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)
    return buf.toString('utf8')
  } finally { closeSync(fd) }
}

// Terminal output as SSE: the buffered screen first, then live chunks; 'end' when the run is over.
app.get('/api/runs/:id/pty', (req, res) => {
  const r = runRow(req)
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`)
  const end = () => { res.write('event: end\ndata: {}\n\n'); res.end() }
  const stop = watchPty(r.id, d => d === null ? end() : send(d))
  if (!stop) { send(ptyTail(r.id)); return end() }
  const beat = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { clearInterval(beat); stop() })
})

app.post('/api/runs/:id/pty/input', (req, res) => {
  const data = req.body?.data
  if (typeof data !== 'string' || !data || data.length > 64 * 1024) throw fail(400, 'data must be text')
  ptyInput(runRow(req).id, data)
  res.json({ ok: true })
})

app.post('/api/runs/:id/pty/resize', (req, res) => {
  const cols = Number(req.body?.cols), rows = Number(req.body?.rows)
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) throw fail(400, 'bad size')
  ptyResize(runRow(req).id, cols, rows)
  res.json({ ok: true })
})

app.post('/api/runs/:id/send', (req, res) => {
  sendToRun(runRow(req).id, str(req.body?.text, 'text'))
  res.json({ ok: true })
})

app.post('/api/runs/:id/interrupt', async (req, res) => {
  await interruptRun(runRow(req).id)
  res.json({ ok: true })
})

app.post('/api/runs/:id/resume', (req, res) => {
  const text = req.body?.text
  resumeRun(runRow(req).id, typeof text === 'string' && text.trim() ? text : undefined)
  res.json({ ok: true })
})

app.post('/api/runs/:id/handoff', async (req, res) => res.json(await handoffRun(runRow(req).id)))

app.post('/api/runs/:id/kill', (req, res) => {
  const r = runRow(req)
  killRun(r.id)
  // A stopped run is the owner's call, not a failed attempt; the task waits on the Board for a retry.
  if (r.task_id) setTask(r.task_id, { status: 'blocked', notes: 'Stopped by the owner. Retry to start again.' })
  log(r.project_id, 'kill', `Run #${r.id} stopped by the owner`, { task_id: r.task_id, agent_id: r.agent_id })
  res.json({ ok: true })
})

app.post('/api/runs/:id/permission', (req, res) => {
  const { request_id, allow, message, remember } = req.body ?? {}
  answer(runRow(req).id, str(request_id, 'request_id'), allow === true, { message: typeof message === 'string' ? message : undefined, remember: remember === true })
  res.json({ ok: true })
})
