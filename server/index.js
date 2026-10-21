import express from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { all, get, run, insert, update, getProject, getAgent, getTask, getOrder, activeAgents, setTask, setAgent, log, resolveInbox, now } from './db.js'
import { bus, emit } from './bus.js'
import { TEMPLATES, template, createAgent, seedRoster } from './roster.js'
import { killProject, killRun, tokensToday, projectTokensToday, sendToRun, interruptRun, resumeRun, handoffRun, answerPermission, getRunEvents } from './runner.js'
import { repoInfo, mergePR } from './github.js'
import { runOnboarding } from './onboarding.js'
import { chat, revisePlan, approvePlan, rejectPlan } from './orchestrator.js'
import { start, kick, markMerged, markOnboarded, resumeChecks, removeAgent, pauseAgent, resumeAgent } from './scheduler.js'
import { initNotify, publicKey } from './notify.js'
import { mcpHandler, answerFromOwner } from './crewmcp.js'
import { matchAgent } from './rules.js'

if (!process.env.OWNER_TOKEN) {
  console.error('OWNER_TOKEN is not set. Put OWNER_TOKEN=<long random string> in .env and restart.')
  process.exit(1)
}

const sha = s => createHash('sha256').update(s).digest()
const SESSION = sha(process.env.OWNER_TOKEN).toString('hex')
const fail = (status, message) => Object.assign(new Error(message), { status })
const int = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw fail(400, 'bad id'); return n }
const found = (row, what) => { if (!row) throw fail(404, `${what} not found`); return row }
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStrs = v => Array.isArray(v) && v.every(s => typeof s === 'string')
const str = (v, what) => { if (typeof v !== 'string' || !v.trim()) throw fail(400, `${what} is required`); return v }

// Long work reports through SSE; errors still land in the activity feed.
const background = (project_id, p) => Promise.resolve(p).catch(e => { console.error(e); log(project_id, 'error', e.message) })

const project = req => found(getProject(int(req.params.id)), 'project')
const agent = req => { const a = getAgent(int(req.params.id)); if (!a || a.removed_at) throw fail(404, 'agent not found'); return a }

const EDITABLE = {
  name: v => typeof v === 'string' && v.trim() !== '',
  specialty: v => typeof v === 'string',
  instructions: v => typeof v === 'string',
  model: v => typeof v === 'string' && v !== '',
  effort: v => typeof v === 'string' && v !== '',
  owned_paths: isStrs,
  readonly_paths: isStrs,
  permissions: v => isObj(v) && Object.values(v).every(b => typeof b === 'boolean'),
  max_parallel: v => Number.isInteger(v) && v >= 1,
  daily_token_budget: v => Number.isInteger(v) && v >= 0,
}

function profileFields(body) {
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE[k]) throw fail(400, `${k} is not editable`)
    if (!EDITABLE[k](v)) throw fail(400, `invalid ${k}`)
  }
  return body
}

function retryTask(id) {
  const t = setTask(id, { attempts: 0, notes: '', status: 'planned' })
  kick()
  return t
}

export const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '1mb' }))

// Crew MCP for agent sessions on this host; auth is the per-run token, not the owner cookie.
app.all('/mcp/:token', mcpHandler)

app.post('/api/login', (req, res) => {
  const token = req.body?.token
  if (typeof token !== 'string' || !timingSafeEqual(sha(token), sha(process.env.OWNER_TOKEN))) throw fail(401, 'wrong token')
  res.cookie('crew', SESSION, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000 })
  res.json({ ok: true })
})

app.use('/api', (req, res, next) => {
  const c = Buffer.from((req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('crew='))?.slice(5) || '')
  if (c.length !== SESSION.length || !timingSafeEqual(c, Buffer.from(SESSION))) throw fail(401, 'not logged in')
  next()
})

app.get('/api/me', (req, res) => res.json({ ok: true }))
app.post('/api/logout', (req, res) => { res.clearCookie('crew'); res.json({ ok: true }) })

// Projects

app.get('/api/projects', (req, res) => res.json(all('SELECT * FROM projects ORDER BY id')))

app.post('/api/projects', async (req, res) => {
  const repo = req.body?.repo
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail(400, 'repo must be owner/name')
  if (get('SELECT id FROM projects WHERE repo = ?', repo)) throw fail(409, 'project already exists')
  const info = await repoInfo(repo)
  const id = insert('projects', { name: info.name, repo, default_branch: info.default_branch })
  seedRoster(id)
  background(id, runOnboarding(id))
  const p = getProject(id)
  emit('project', id, p)
  res.json(p)
})

app.get('/api/projects/:id', (req, res) => {
  const p = project(req)
  const rl = get("SELECT value FROM kv WHERE key = 'rate_limit'")?.value
  res.json({
    ...p,
    running_runs: all("SELECT * FROM runs WHERE project_id = ? AND status = 'running' ORDER BY id", p.id),
    tokens_today: projectTokensToday(p.id),
    rate_limit: rl ? JSON.parse(rl) : null,
  })
})

app.patch('/api/projects/:id', (req, res) => {
  const p = project(req)
  const { name, settings, ...rest } = req.body ?? {}
  if (Object.keys(rest).length) throw fail(400, `${Object.keys(rest)[0]} is not editable`)
  const f = {}
  if (name !== undefined) f.name = str(name, 'name')
  if (settings !== undefined) {
    if (!isObj(settings)) throw fail(400, 'settings must be an object')
    f.settings = { ...p.settings, ...settings }
  }
  update('projects', p.id, f)
  const out = getProject(p.id)
  emit('project', p.id, out)
  res.json(out)
})

app.post('/api/projects/:id/onboard', (req, res) => {
  const p = project(req)
  background(p.id, runOnboarding(p.id))
  res.status(202).json({ ok: true })
})

app.post('/api/projects/:id/kill', async (req, res) => {
  const p = project(req)
  update('projects', p.id, { paused: 1 })
  await killProject(p.id)
  for (const t of all("SELECT id FROM tasks WHERE project_id = ? AND status = 'in_progress'", p.id)) setTask(t.id, { status: 'planned' })
  log(p.id, 'kill', 'Kill switch: all agents stopped, project paused')
  emit('project', p.id, getProject(p.id))
  res.json({ ok: true })
})

app.post('/api/projects/:id/resume', (req, res) => {
  const p = project(req)
  update('projects', p.id, { paused: 0 })
  log(p.id, 'resume', 'Project resumed')
  emit('project', p.id, getProject(p.id))
  resumeChecks(p.id)
  kick()
  res.json({ ok: true })
})

// Chat and orders

app.get('/api/projects/:id/messages', (req, res) => {
  res.json(all('SELECT * FROM (SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id', project(req).id))
})

app.post('/api/projects/:id/messages', (req, res) => {
  const p = project(req)
  background(p.id, chat(p.id, str(req.body?.text, 'text')))
  res.status(202).json({ ok: true })
})

app.get('/api/projects/:id/orders', (req, res) => res.json(all(`SELECT o.*,
  (SELECT COUNT(*) FROM tasks WHERE order_id = o.id) total, (SELECT COUNT(*) FROM tasks WHERE order_id = o.id AND status = 'done') done
  FROM orders o WHERE project_id = ? ORDER BY id DESC`, project(req).id)))

const order = req => found(getOrder(int(req.params.id)), 'order')

app.get('/api/orders/:id', (req, res) => {
  const o = order(req)
  res.json({ ...o, tasks: all('SELECT * FROM tasks WHERE order_id = ? ORDER BY id', o.id) })
})

app.post('/api/orders/:id/approve', async (req, res) => {
  const o = order(req), tasks = req.body?.tasks
  if (tasks != null && !(Array.isArray(tasks) && tasks.every(isObj))) throw fail(400, 'tasks must be an array of objects')
  await approvePlan(o.id, tasks ?? null)
  res.json({ ok: true })
})

app.post('/api/orders/:id/revise', (req, res) => {
  const o = order(req)
  background(o.project_id, revisePlan(o.id, str(req.body?.feedback, 'feedback')))
  res.status(202).json({ ok: true })
})

app.post('/api/orders/:id/reject', async (req, res) => {
  await rejectPlan(order(req).id)
  res.json({ ok: true })
})

// Tasks

app.get('/api/projects/:id/tasks', (req, res) => {
  const p = project(req), { agent_id, order_id } = req.query
  let sql = 'SELECT t.*, a.name agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.project_id = ?'
  const params = [p.id]
  if (agent_id) sql += ' AND t.agent_id = ?', params.push(int(agent_id))
  if (order_id) sql += ' AND t.order_id = ?', params.push(int(order_id))
  res.json(all(sql + ' ORDER BY t.id', ...params))
})

// Direct task: a one-task order for a named agent, no plan round trip. Reviewer and QA still run.
app.post('/api/projects/:id/tasks', (req, res) => {
  const p = project(req)
  const { agent: name, title, description = '', acceptance = [], files = [] } = req.body ?? {}
  str(title, 'title')
  if (typeof description !== 'string' || !isStrs(acceptance) || !isStrs(files)) throw fail(400, 'description must be text, acceptance and files lists of text')
  const a = activeAgents(p.id).find(x => x.name === str(name, 'agent'))
  if (!a?.owned_paths.length) throw fail(400, `${name} is not an agent that owns paths`)
  if (!matchAgent([a], { files })) throw fail(400, `${a.name} does not own ${files.join(', ')}`)
  const spec = { key: 't1', title, agent: a.name, description, acceptance, files, size: 'S', depends_on: [] }
  const order_id = insert('orders', { project_id: p.id, text: title, status: 'in_progress', plan: { summary: title, direct: true, tasks: [spec] } })
  const task_id = insert('tasks', { project_id: p.id, order_id, plan_key: 't1', title, description, role: a.role, plan_agent: a.name, acceptance, files, size: 'S', agent_id: a.id })
  emit('order', p.id, getOrder(order_id))
  log(p.id, 'order', `Quick task for ${a.name}: ${title}`, { order_id, task_id, agent_id: a.id })
  const t = setTask(task_id, {})
  kick()
  res.json(t)
})

app.get('/api/tasks/:id', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  res.json({
    ...t,
    activity: all('SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC', t.id),
    runs: all('SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC', t.id),
  })
})

app.post('/api/tasks/:id/retry', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  res.json(retryTask(t.id))
})

// Wall: one request to boot the screen, SSE after that.

export const crewFeed = (project_id, limit = 50) => all(`SELECT * FROM (
  SELECT m.*, f.name from_name, t.name to_name FROM crew_messages m
  LEFT JOIN agents f ON f.id = m.from_agent_id LEFT JOIN agents t ON t.id = m.to_agent_id
  WHERE m.project_id = ? ORDER BY m.id DESC LIMIT ?) ORDER BY id`, project_id, limit)

app.get('/api/projects/:id/wall', (req, res) => {
  const p = project(req)
  // shortcut: one tile per agent shows its newest run; a reviewer running two checks shows only the latest.
  const agents = activeAgents(p.id).map(a => ({
    ...a,
    tokens_today: tokensToday(a.id),
    run: get(`SELECT r.*, t.title task_title FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.agent_id = ? ORDER BY r.status = 'running' DESC, r.id DESC`, a.id) ?? null,
  }))
  const orders = all(`SELECT * FROM orders WHERE project_id = ? AND status NOT IN ('done', 'rejected') ORDER BY id DESC`, p.id).map(o => ({
    ...o, counts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM tasks WHERE order_id = ? GROUP BY status', o.id).map(c => [c.status, c.n])),
  }))
  const permissions = all(`SELECT r.id run_id, r.pending_permission, a.name agent_name FROM runs r LEFT JOIN agents a ON a.id = r.agent_id
    WHERE r.project_id = ? AND r.status = 'running' AND r.pending_permission IS NOT NULL`, p.id)
  res.json({ agents, orders, permissions, crew: crewFeed(p.id) })
})

// Runs: live transcript and intervention

const runRow = req => found(get('SELECT * FROM runs WHERE id = ?', int(req.params.id)), 'run')

app.get('/api/runs/:id', (req, res) => res.json(runRow(req)))

app.get('/api/runs/:id/events', (req, res) => {
  const r = runRow(req), { after, tail } = req.query
  res.json(getRunEvents(r.id, tail ? { tail: Math.min(int(tail), 500) } : { after: after ? Number(after) || 0 : 0 }))
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
  const { request_id, allow, message } = req.body ?? {}
  answerPermission(runRow(req).id, str(request_id, 'request_id'), allow === true, { message: typeof message === 'string' ? message : undefined })
  res.json({ ok: true })
})

// Agents

app.get('/api/templates', (req, res) => res.json(TEMPLATES))

app.get('/api/projects/:id/agents', (req, res) => {
  res.json(activeAgents(project(req).id).map(a => ({
    ...a,
    tokens_today: tokensToday(a.id),
    current_task: get("SELECT title FROM tasks WHERE agent_id = ? AND status = 'in_progress' ORDER BY id DESC", a.id)?.title ?? null,
    last_event: get("SELECT last_event FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY id DESC", a.id)?.last_event ?? null,
  })))
})

app.post('/api/projects/:id/agents', (req, res) => {
  const p = project(req)
  const { role, ...fields } = req.body ?? {}
  profileFields(fields)
  let base = { role: 'custom' }
  if (role !== undefined && role !== 'custom') base = found(template(role), 'template')
  const a = { ...base, ...fields }
  str(a.name, 'name')
  const out = createAgent(p.id, a)
  emit('agent', p.id, out)
  res.json(out)
})

app.get('/api/agents/:id', (req, res) => {
  const a = agent(req)
  res.json({
    ...a,
    notes: all('SELECT * FROM agent_notes WHERE agent_id = ? ORDER BY id DESC', a.id),
    tasks: all('SELECT * FROM tasks WHERE agent_id = ? ORDER BY id DESC LIMIT 20', a.id),
    runs: all('SELECT * FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 10', a.id),
  })
})

app.patch('/api/agents/:id', (req, res) => res.json(setAgent(agent(req).id, profileFields(req.body ?? {}))))

app.post('/api/agents/:id/clone', (req, res) => {
  const a = agent(req)
  let n = 2
  while (get('SELECT 1 FROM agents WHERE project_id = ? AND name = ? AND removed_at IS NULL', a.project_id, `${a.name} ${n}`)) n++
  const copy = { role: a.role }
  for (const k of Object.keys(EDITABLE)) copy[k] = a[k]
  const out = createAgent(a.project_id, { ...copy, name: `${a.name} ${n}` })
  emit('agent', a.project_id, out)
  res.json(out)
})

app.post('/api/agents/:id/pause', async (req, res) => res.json(await pauseAgent(agent(req).id)))

app.post('/api/agents/:id/resume', (req, res) => res.json(resumeAgent(agent(req).id)))

app.delete('/api/agents/:id', (req, res) => {
  const a = agent(req)
  if (!a.removable) throw fail(400, `${a.name} cannot be removed`)
  // Every PR goes through a reviewer and QA, so the last one of each stays.
  if (['reviewer', 'qa'].includes(a.role) && activeAgents(a.project_id).filter(x => x.role === a.role).length < 2)
    throw fail(400, `${a.name} is the only ${a.role} agent. Add another one first, or pause it instead.`)
  res.json(removeAgent(a.id))
})

app.post('/api/agents/:id/notes', (req, res) => {
  const a = agent(req)
  const id = insert('agent_notes', { agent_id: a.id, text: str(req.body?.text, 'text') })
  res.json(get('SELECT * FROM agent_notes WHERE id = ?', id))
})

// Inbox

app.get('/api/projects/:id/inbox', (req, res) => {
  const p = project(req), { status } = req.query
  if (status && status !== 'open' && status !== 'done') throw fail(400, 'status must be open or done')
  res.json(status
    ? all('SELECT * FROM inbox WHERE project_id = ? AND status = ? ORDER BY id DESC', p.id, status)
    : all('SELECT * FROM inbox WHERE project_id = ? ORDER BY id DESC', p.id))
})

app.post('/api/inbox/:id/action', async (req, res) => {
  const item = found(get('SELECT * FROM inbox WHERE id = ?', int(req.params.id)), 'inbox item')
  if (item.status !== 'open') throw fail(409, 'already resolved')
  const { action, text } = req.body ?? {}
  const key = `${item.kind}:${action}`
  let status = 200
  if (item.kind === 'permission') {
    if (!['allow', 'deny', 'dismiss'].includes(action)) throw fail(400, `unknown action ${action} for permission`)
    // A run that already ended leaves nothing to answer; the item still closes.
    try { answerPermission(item.run_id, item.ref, action === 'allow', { message: typeof text === 'string' && text.trim() ? text : undefined }) }
    catch (e) { resolveInbox(item.id); throw e }
  } else if (action === 'dismiss' && item.kind !== 'plan') {
    // nothing to run
  } else if (key === 'plan:approve') await approvePlan(found(item.order_id, 'order'))
  else if (key === 'plan:reject') await rejectPlan(found(item.order_id, 'order'))
  else if (key === 'plan:revise') {
    background(item.project_id, revisePlan(found(item.order_id, 'order'), str(text, 'text')))
    status = 202
  } else if (key === 'merge:merge') {
    const p = getProject(item.project_id)
    if (item.task_id) {
      const t = found(getTask(item.task_id), 'task')
      await mergePR(p, found(t.pr_number, 'pull request'))
      markMerged(t.id)
    } else {
      await mergePR(p, found(p.onboarding_pr, 'onboarding pull request'))
      markOnboarded(p.id)
    }
  } else if (key === 'question:answer') {
    // Agent questions go back to the agent; anything else is a note for the Orchestrator.
    if (!answerFromOwner(item, str(text, 'text'))) {
      background(item.project_id, chat(item.project_id, `Answer to "${item.title}": ${text}`))
      status = 202
    }
  } else if (key === 'failure:retry') retryTask(found(item.task_id, 'task'))
  else throw fail(400, `unknown action ${action} for ${item.kind}`)
  resolveInbox(item.id)
  res.status(status).json({ ok: true })
})

app.get('/api/projects/:id/activity', (req, res) => {
  const p = project(req), limit = req.query.limit ? int(req.query.limit) : 100
  res.json(all('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?', p.id, Math.min(limit, 1000)))
})

// Live events and push

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write(': connected\n\n')
  const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`)
  const beat = setInterval(() => res.write(': ping\n\n'), 25000)
  bus.on('event', send)
  req.on('close', () => { clearInterval(beat); bus.off('event', send) })
})

app.get('/api/push/key', (req, res) => res.json({ publicKey: publicKey() }))

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body?.subscription
  if (!isObj(sub) || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !isObj(sub.keys)) throw fail(400, 'invalid subscription')
  run('INSERT INTO push_subs (endpoint, sub) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub', sub.endpoint, JSON.stringify(sub))
  res.json({ ok: true })
})

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }))

// Web app

const DIST = join(import.meta.dirname, '..', 'web', 'dist')
app.use(express.static(DIST))
app.get('/{*any}', (req, res, next) => res.sendFile(join(DIST, 'index.html'), e => e && next(fail(404, 'web app not built, run npm run build'))))

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500) console.error(err)
  res.status(status).json({ error: status >= 500 && !err.message ? 'server error' : err.message })
})

if (import.meta.main) {
  initNotify()
  start()
  const port = process.env.PORT || 5190
  app.listen(port, () => console.log(`Agent Crew on http://localhost:${port}`))
}
