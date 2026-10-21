import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { relative, isAbsolute, join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { all, insert, update, get, run, getAgent, getProject, setAgent, addRunEvent, addInbox, resolveInbox, now, DATA_DIR } from './db.js'
import { emit } from './bus.js'

// run_id -> live entry. A run outlives its child: interrupt, idle timeout and handoff drop the child and --resume brings it back.
const live = new Map()
// MCP run token -> run_id; dies with the run.
const tokens = new Map()

const AGENT_KINDS = ['task', 'review', 'qa']
const IDLE_MS = 10 * 60 * 1000
const MAX_STR = 4000

// Short live status line for a tool call, e.g. "Edit web/App.jsx" or "Bash npm test".
export function describe(name, input = {}, cwd) {
  let arg = input.file_path || input.notebook_path || input.path || input.command || input.pattern || input.url || input.description || ''
  if (typeof arg !== 'string') arg = ''
  if ((input.file_path || input.notebook_path || input.path) && isAbsolute(arg)) {
    const r = relative(cwd, arg)
    if (r && !r.startsWith('..')) arg = r
  }
  arg = arg.replaceAll('\\', '/').split('\n')[0]
  return `${name.replace(/^mcp__crew__/, '')} ${arg}`.trim().slice(0, 200)
}

// Copy with long strings cut, so file dumps in tool results do not bloat the transcript table.
const slim = v => typeof v === 'string' ? (v.length > MAX_STR ? v.slice(0, MAX_STR) + `\n... [${v.length - MAX_STR} more chars]` : v)
  : Array.isArray(v) ? v.map(slim)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slim(x)])) : v

function runRow(id) { return get('SELECT * FROM runs WHERE id = ?', id) }

function settleAgent(agent_id) {
  if (!agent_id) return
  const a = getAgent(agent_id)
  if (a?.status === 'working' && runningCount(agent_id) === 0) setAgent(agent_id, { status: 'idle' })
}

const store = (e, type, obj) => addRunEvent(e.run_id, e.project_id, ++e.seq, type, JSON.stringify(slim(obj)))
const write = (e, obj) => { if (e.child?.stdin.writable) e.child.stdin.write(JSON.stringify(obj) + '\n') }
const userMsg = (e, text, priority) => {
  e.sent++
  write(e, { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: e.session_id || '', ...(priority && { priority }) })
}

function setRun(e, fields, emitNow = true) {
  update('runs', e.run_id, fields)
  if (emitNow) emit('run', e.project_id, runRow(e.run_id))
}
const setState = (e, state) => { e.state = state; setRun(e, { state }) }

function throttledEmit(e) {
  if (e.emitTimer) return
  const wait = 1000 - (Date.now() - e.lastEmit)
  const flush = () => { e.emitTimer = null; e.lastEmit = Date.now(); emit('run', e.project_id, runRow(e.run_id)) }
  if (wait <= 0) flush()
  else e.emitTimer = setTimeout(flush, wait)
}

function delta(e, text) {
  e.delta += text
  if (e.deltaTimer) return
  e.deltaTimer = setTimeout(() => {
    e.deltaTimer = null
    if (e.delta) emit('run_delta', e.project_id, { run_id: e.run_id, text: e.delta })
    e.delta = ''
  }, 250)
}

// Our own control request (interrupt). Resolves with the response, or null after ms.
function control(e, request, ms) {
  const request_id = `crew_${++e.ctrlN}`
  return new Promise(resolve => {
    const timer = setTimeout(() => { e.ctrl.delete(request_id); resolve(null) }, ms)
    e.ctrl.set(request_id, r => { clearTimeout(timer); resolve(r) })
    write(e, { type: 'control_request', request_id, request })
  })
}

const respond = (e, request_id, response) => write(e, { type: 'control_response', response: { subtype: 'success', request_id, response } })

const syncPending = e => setRun(e, { pending_permission: e.perms.size ? [...e.perms.values()].map(p => p.req) : null })

function onPermission(e, request_id, q) {
  const input = q.input || {}
  const summary = describe(q.tool_name, input, e.cwd)
  const verdict = e.opts.permissionPolicy ? e.opts.permissionPolicy(q.tool_name, input) : 'deny'
  if (verdict === 'allow') return respond(e, request_id, { behavior: 'allow', updatedInput: input })
  if (verdict === 'deny') {
    store(e, 'note', { text: `Denied by policy: ${summary}` })
    return respond(e, request_id, { behavior: 'deny', message: 'Crew policy does not allow this. Do it another way, or say what is missing in your final message.' })
  }
  const req = { request_id, tool_name: q.tool_name, input: slim(input), summary, at: now() }
  const min = getProject(e.project_id)?.settings.permission_timeout_min || 15
  const timer = setTimeout(() => answerPermission(e.run_id, request_id, false, { message: 'The owner did not answer in time. Continue without it, or ask with crew_ask.' }), min * 60000)
  e.perms.set(request_id, { req, timer })
  syncPending(e)
  store(e, 'control_request', req)
  const who = getAgent(e.agent_id)?.name || e.kind
  addInbox(e.project_id, 'permission', `${who} asks to run: ${summary}`, {
    body: JSON.stringify(req.input, null, 2).slice(0, 1500), run_id: e.run_id, ref: request_id, task_id: e.task_id,
  })
}

function closePermissionItems(run_id, ref) {
  const rows = ref
    ? all(`SELECT id FROM inbox WHERE run_id = ? AND ref = ? AND status = 'open'`, run_id, ref)
    : all(`SELECT id FROM inbox WHERE run_id = ? AND kind = 'permission' AND status = 'open'`, run_id)
  for (const i of rows) resolveInbox(i.id)
}

function onResult(e, m) {
  e.result = m
  const u = m.usage || {}
  e.input_tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  e.output_tokens += u.output_tokens || 0
  // total_cost_usd is cumulative for one process, so keep the cost of earlier processes and add the latest.
  e.cost_now = m.total_cost_usd || 0
  e.turn++
  store(e, 'result', { subtype: m.subtype, is_error: m.is_error, result: m.result, input_tokens: e.input_tokens, output_tokens: e.output_tokens, cost_usd: e.cost_done + e.cost_now })
  setRun(e, { turn: e.turn, input_tokens: e.input_tokens, output_tokens: e.output_tokens, cost_usd: e.cost_done + e.cost_now })
  // Owner messages still queued in the CLI start another turn.
  if (e.sent > e.replayed) return
  if (e.keepOpen) {
    if (e.state === 'running') setState(e, 'waiting')
    clearTimeout(e.idleTimer)
    e.idleTimer = setTimeout(() => { if (e.child) detach(e, e.state === 'handed_off' ? 'handed_off' : 'paused') }, IDLE_MS).unref()
    return
  }
  e.child?.stdin.end()
}

function onLine(e, line) {
  if (!line.trim()) return
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type === 'stream_event') {
    const d = m.event?.delta
    if (m.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) delta(e, d.text)
  } else if (m.type === 'system') {
    if (m.subtype === 'init' && m.session_id && m.session_id !== e.session_id) {
      e.session_id = m.session_id
      setRun(e, { session_id: e.session_id }, false)
    }
    if (m.subtype === 'permission_denied') store(e, 'note', { text: `Denied: ${describe(m.tool_name || 'tool', {}, e.cwd)} ${m.message || ''}`.trim() })
  } else if (m.type === 'assistant') {
    for (const c of m.message?.content || []) {
      if (c.type === 'text' && c.text) e.lastText = c.text
      if (c.type === 'tool_use') {
        update('runs', e.run_id, { last_event: describe(c.name, c.input, e.cwd) })
        throttledEmit(e)
      }
    }
    const content = (m.message?.content || []).filter(c => c.type !== 'thinking' || c.thinking)
    if (content.length) store(e, 'assistant', { content })
  } else if (m.type === 'user') {
    // A string content is our own message echoed back by --replay-user-messages: the CLI took it.
    if (typeof m.message?.content === 'string') e.replayed++
    else store(e, 'user', { content: m.message?.content || [] })
  } else if (m.type === 'result') {
    onResult(e, m)
  } else if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
    onPermission(e, m.request_id, m.request)
  } else if (m.type === 'control_response') {
    const id = m.response?.request_id
    e.ctrl.get(id)?.(m.response)
    e.ctrl.delete(id)
  } else if (m.type === 'rate_limit_event') {
    const w = m.rate_limit_info?.unifiedWindows?.five_hour
    if (w?.utilization != null) {
      const value = JSON.stringify({ utilization: w.utilization, resetsAt: w.resetsAt ?? m.rate_limit_info.resetsAt ?? null, at: now() })
      run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'rate_limit', value)
    }
  }
}

function args(e, resume) {
  const o = e.opts
  const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--setting-sources', 'project', '--strict-mcp-config', '--permission-prompt-tool', 'stdio',
    '--model', o.model || 'sonnet', '--effort', o.effort || 'medium', '--permission-mode', o.permissionMode || 'dontAsk']
  if (e.spFile) a.push('--append-system-prompt-file', e.spFile)
  // Deny rules apply under every permission mode, bypassPermissions included; --disallowedTools is the same list as insurance.
  const deny = o.disallowedTools || []
  if (deny.length) a.push('--settings', JSON.stringify({ permissions: { deny } }), '--disallowedTools', deny.join(','))
  // Comma-joined single arg: the flags are variadic and would swallow following args.
  if (o.allowedTools?.length) a.push('--allowedTools', o.allowedTools.join(','))
  if (e.token) a.push('--mcp-config', JSON.stringify({ mcpServers: { crew: { type: 'http', url: `http://127.0.0.1:${process.env.PORT || 5190}/mcp/${e.token}` } } }))
  if (resume) a.push('--resume', resume)
  return a
}

function spawnChild(e, text, resume) {
  // Nested sessions refuse to start when the server itself runs inside Claude Code.
  const env = { ...process.env, MCP_TOOL_TIMEOUT: String(60 * 60 * 1000) }
  delete env.CLAUDECODE
  const bin = process.env.CREW_CLAUDE_BIN || 'claude'
  const [cmd, pre] = /\.m?js$/.test(bin) ? [process.execPath, [bin]] : [bin, []]
  e.sent = e.replayed = 0
  e.cost_done += e.cost_now
  e.cost_now = 0
  let child
  try { child = spawn(cmd, [...pre, ...args(e, resume)], { cwd: e.cwd, env, windowsHide: true }) } catch (err) { return finish(e, null, err.message) }
  e.child = child
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', d => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const l of lines) onLine(e, l)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => { e.stderr = (e.stderr + d).slice(-4000) })
  child.stdin.on('error', () => {})
  child.on('error', err => { e.stderr += err.message })
  child.on('close', code => {
    if (buf) onLine(e, buf)
    if (e.child !== child) return
    e.child = null
    for (const [, cb] of e.ctrl) cb(null)
    e.ctrl.clear()
    // Kept alive on purpose (interrupt fallback, idle, handoff): the row waits for resumeRun.
    if (e.detached && !e.killed) { e.detached = false; return }
    finish(e, code)
  })
  write(e, { type: 'control_request', request_id: `crew_${++e.ctrlN}`, request: { subtype: 'initialize', hooks: null } })
  userMsg(e, text)
}

function killChild(child) {
  if (!child) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
  else child.kill('SIGKILL')
}

// Drops the child but keeps the run; resumeRun or sendToRun respawns with --resume.
function detach(e, state) {
  clearTimeout(e.idleTimer)
  for (const p of e.perms.values()) clearTimeout(p.timer)
  e.perms.clear()
  syncPending(e)
  closePermissionItems(e.run_id)
  setState(e, state)
  if (e.child) { e.detached = true; killChild(e.child) }
}

function finish(e, code, spawnError) {
  if (e.done) return
  e.done = true
  for (const t of [e.emitTimer, e.deltaTimer, e.idleTimer]) clearTimeout(t)
  for (const p of e.perms.values()) clearTimeout(p.timer)
  live.delete(e.run_id)
  if (e.token) tokens.delete(e.token)
  if (e.spFile) rmSync(e.spFile, { force: true })
  closePermissionItems(e.run_id)
  const r = e.result
  const ok = !!r && !r.is_error && !e.killed
  const text = r?.result ?? (e.lastText || spawnError || e.stderr.trim() || `claude exited with code ${code}`)
  const status = e.killed ? 'killed' : ok ? 'ok' : 'error'
  const cost_usd = e.cost_done + e.cost_now
  update('runs', e.run_id, { status, session_id: e.session_id, input_tokens: e.input_tokens, output_tokens: e.output_tokens, cost_usd, result_text: text, pending_permission: null, ended_at: now() })
  emit('run', e.project_id, runRow(e.run_id))
  settleAgent(e.agent_id)
  e.resolve({ ok, text, session_id: e.session_id, input_tokens: e.input_tokens, output_tokens: e.output_tokens, cost_usd, run_id: e.run_id, stopped: !!e.stopped })
}

// opts: project_id, agent_id, task_id, kind, cwd, prompt, systemPrompt, model, effort, allowedTools, disallowedTools,
// permissionMode, resume, permissionPolicy(tool, input) -> 'allow'|'deny'|'ask', mcp (crew tool names), keepOpen.
// Resolves once when the run ends for good, however many times its process was respawned.
export function runClaude(opts) {
  const { project_id, agent_id = null, task_id = null, kind, cwd, prompt, systemPrompt, resume = null } = opts
  const run_id = insert('runs', { project_id, agent_id, task_id, kind })
  if (agent_id && AGENT_KINDS.includes(kind) && getAgent(agent_id)?.status !== 'paused') setAgent(agent_id, { status: 'working' })
  emit('run', project_id, runRow(run_id))
  const e = {
    run_id, project_id, agent_id, task_id, kind, cwd, opts, child: null, seq: 0, state: 'running', session_id: resume, turn: 0,
    input_tokens: 0, output_tokens: 0, cost_done: 0, cost_now: 0, result: null, lastText: '', stderr: '', sent: 0, replayed: 0,
    keepOpen: !!opts.keepOpen, ctrl: new Map(), ctrlN: 0, perms: new Map(), delta: '', lastEmit: 0,
  }
  live.set(run_id, e)
  if (opts.mcp?.length) { e.token = randomBytes(24).toString('hex'); tokens.set(e.token, run_id) }
  // Via a file: Windows caps a command line at about 32k chars and prompts with CLAUDE.md get long.
  if (systemPrompt) {
    e.spFile = join(DATA_DIR, 'prompts', `run-${run_id}.txt`)
    mkdirSync(join(DATA_DIR, 'prompts'), { recursive: true })
    writeFileSync(e.spFile, systemPrompt)
  }
  store(e, 'prompt', { text: prompt ?? '' })
  return new Promise(resolve => { e.resolve = resolve; spawnChild(e, prompt ?? '', resume) })
}

const liveRun = run_id => {
  const e = live.get(run_id)
  if (!e) throw Object.assign(new Error('That run is not active'), { status: 409 })
  return e
}

export const isLive = run_id => live.has(run_id)
// True when a message written now reaches a session that is working or between turns (not paused by the owner).
export const canDeliver = run_id => { const e = live.get(run_id); return !!e?.child && (e.state === 'running' || e.state === 'waiting') }

export function sendToRun(run_id, text, { priority = 'next', from = 'owner' } = {}) {
  const e = liveRun(run_id)
  store(e, from === 'owner' ? 'owner' : 'note', { text })
  clearTimeout(e.idleTimer)
  if (e.child) {
    if (e.state !== 'running') setState(e, 'running')
    userMsg(e, text, priority)
  } else {
    if (!e.session_id) throw Object.assign(new Error('No session to resume'), { status: 409 })
    setState(e, 'running')
    spawnChild(e, text, e.session_id)
  }
}

export async function interruptRun(run_id) {
  const e = liveRun(run_id)
  e.keepOpen = true
  setState(e, 'paused')
  store(e, 'note', { text: 'Paused' })
  if (!e.child) return
  // No answer means the CLI is stuck; the session file survives, so --resume picks it up.
  const r = await control(e, { subtype: 'interrupt' }, 5000)
  // Interrupt drops queued messages, so none are still owed a turn.
  e.replayed = e.sent
  if (!r && e.child) detach(e, 'paused')
}

export function resumeRun(run_id, text = 'Continue the task where you left off.') {
  const e = liveRun(run_id)
  e.keepOpen = false
  store(e, 'note', { text: e.state === 'handed_off' ? 'Handed back' : 'Resumed' })
  sendToRun(run_id, text, { from: 'crew' })
}

// The owner continues the session in a terminal; two processes on one session would corrupt it, so ours stops.
export async function handoffRun(run_id) {
  const e = liveRun(run_id)
  if (e.child) await interruptRun(run_id)
  detach(e, 'handed_off')
  store(e, 'note', { text: 'Handed off to the owner' })
  return { cwd: e.cwd, session_id: e.session_id, command: `claude --resume ${e.session_id}` }
}

export function answerPermission(run_id, request_id, allow, { message } = {}) {
  const e = liveRun(run_id)
  const p = e.perms.get(request_id)
  if (!p) throw Object.assign(new Error('That permission request is no longer open'), { status: 409 })
  clearTimeout(p.timer)
  e.perms.delete(request_id)
  respond(e, request_id, allow ? { behavior: 'allow', updatedInput: p.req.input } : { behavior: 'deny', message: message || 'The owner denied this. Continue without it.' })
  store(e, 'note', { text: `${allow ? 'Allowed' : 'Denied'}: ${p.req.summary}${message && !allow ? ` (${message})` : ''}` })
  syncPending(e)
  closePermissionItems(run_id, request_id)
}

export const getRunEvents = (run_id, { after = 0, tail } = {}) => tail
  ? all('SELECT * FROM (SELECT * FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', run_id, tail)
  : all('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 500', run_id, after)

export function runForToken(token) {
  const id = tokens.get(token)
  const e = id && live.get(id)
  return e ? { run_id: e.run_id, project_id: e.project_id, agent_id: e.agent_id, task_id: e.task_id, kind: e.kind, tools: e.opts.mcp } : null
}

// stopped: whoever kills already put the task where it belongs, so callers must not count a failed attempt.
export function killRun(run_id, { stopped = true } = {}) {
  const e = live.get(run_id)
  if (!e) return
  e.killed = true
  e.stopped = stopped
  if (e.child) killChild(e.child)
  else finish(e, null)
}

export function killProject(project_id) {
  for (const [id, e] of live) if (e.project_id === project_id) killRun(id)
  // Rows left 'running' by a previous server process have no child to kill.
  run(`UPDATE runs SET status = 'killed', ended_at = ? WHERE project_id = ? AND status = 'running' AND id NOT IN (${[...live.keys()].join(',') || 0})`, now(), project_id)
}

export const liveRuns = () => [...live.values()].map(e => ({ run_id: e.run_id, project_id: e.project_id, agent_id: e.agent_id, task_id: e.task_id, kind: e.kind, state: e.state }))

// started_at is UTC; compare against local midnight converted to the same format.
function todayStart() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

export const tokensToday = agent_id =>
  get('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', agent_id, todayStart()).n

export const projectTokensToday = project_id =>
  get('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM runs WHERE project_id = ? AND started_at >= ?', project_id, todayStart()).n

export const runningCount = agent_id =>
  get(`SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'running'`, agent_id).n
