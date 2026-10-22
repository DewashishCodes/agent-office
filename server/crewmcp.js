import { all, get, run, insert, getAgent, getTask, getProject, activeAgents, addInbox, resolveInbox } from './db.js'
import { emit } from './bus.js'
import { runForToken, sendToRun, canDeliver } from './runner.js'
import { askFromAgent } from './orchestrator.js'
import { searchVault, describeHits, readForAgent, addEntry } from './vault.js'
import { startService, stopService, listServices, serviceText } from './services.js'
import { suggestOrder } from './support.js'

const serviceRow = id => get('SELECT * FROM services WHERE id = ?', id)

// Crew tools over MCP streamable HTTP: POST JSON-RPC in, application/json out. Only what Claude Code calls is implemented.

export const CREW_TOOLS = ['crew_post', 'crew_ask', 'crew_read', 'crew_task_status', 'vault_search', 'vault_read', 'vault_write']
export const VAULT_READ = ['vault_search', 'vault_read']
export const mcpNames = tools => tools.map(t => `mcp__crew__${t}`)

const PEER_WAIT_MS = 10 * 60 * 1000

const TOOLS = {
  crew_post: {
    description: 'Send a message to a crew mate by agent name, to "all", to "orchestrator" or to "owner". Does not wait. Use it to tell others about API shapes, renamed files or decisions they need.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'Agent name, "all", "orchestrator" or "owner"' }, text: { type: 'string' } }, required: ['to', 'text'] },
  },
  crew_ask: {
    description: 'Ask a question and wait for the answer. "orchestrator" knows the plan and the codebase; a peer agent by name knows its own task; "owner" only when the answer changes scope. Waits up to 30 minutes.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, question: { type: 'string' } }, required: ['to', 'question'] },
  },
  crew_read: {
    description: 'Read crew messages addressed to you, to everyone, or about your task.',
    inputSchema: { type: 'object', properties: {} },
  },
  crew_task_status: {
    description: 'Status of the tasks in your order (or one task by id): title, status, branch, PR and the result summary its agent wrote.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'number' } } },
  },
  vault_search: {
    description: 'Search the shared context vault: owner notes, decisions the crew recorded, uploaded specs and files. Use it before guessing about conventions, APIs, designs or earlier decisions. Returns ids, titles and snippets.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'A few keywords' } }, required: ['query'] },
  },
  vault_read: {
    description: 'Read one vault entry in full by id (from vault_search or the list in your prompt). Binary files come back as a path to open with the Read tool.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  service_start: {
    description: 'Start a long-running process (dev server, watcher) that keeps running after your session ends. One plain command such as "npm run dev" or "node server.js". Returns the URL once it prints one.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Short name, e.g. "web" or "api"' }, command: { type: 'string' } }, required: ['name', 'command'] },
  },
  service_stop: {
    description: 'Stop a running service by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  service_list: {
    description: 'Services of this project: name, command, status, URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  service_logs: {
    description: 'The last lines a service printed (plain text). Use it to check that a server came up or to find an error.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, lines: { type: 'number' } }, required: ['name'] },
  },
  suggest_order: {
    description: 'When a request needs a code change, hand it to the build team: write a clear, self-contained order. The owner gets a button to send it; nothing happens without them.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  vault_write: {
    description: 'Record a decision or finding the rest of the crew should know later (an API shape, a naming rule, a gotcha you hit). Short and specific. Not for progress updates; use crew_post for those.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body'] },
  },
}

// Waiters resolved by an answer: owner questions by inbox id, peer questions by "asker:peer".
const ownerWaits = new Map()
const peerWaits = new Map()

const nameOf = id => (id ? getAgent(id)?.name : null) || 'the owner'

function addMessage(fields) {
  const id = insert('crew_messages', fields)
  const m = get(`SELECT m.*, f.name from_name, t.name to_name FROM crew_messages m LEFT JOIN agents f ON f.id = m.from_agent_id
    LEFT JOIN agents t ON t.id = m.to_agent_id WHERE m.id = ?`, id)
  emit('crew_message', m.project_id, m)
  return m
}

// The newest run of this agent that is working or between turns; paused runs wait for the owner, not for peers.
const liveRunOf = agent_id => all(`SELECT id FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY id DESC`, agent_id).find(r => canDeliver(r.id))

function deliver(m, to_agent_id) {
  const r = liveRunOf(to_agent_id)
  if (!r) return false
  const about = m.task_id ? ` about task #${m.task_id}` : ''
  const hint = m.kind === 'question' && m.from_agent_id ? ` (answer with crew_post to "${nameOf(m.from_agent_id)}")` : ''
  sendToRun(r.id, `[Message from ${nameOf(m.from_agent_id)}${about}${hint}]: ${m.text}`, { from: 'crew' })
  return true
}

function recipient(ctx, to) {
  const t = String(to || '').trim()
  const key = t.toLowerCase()
  if (key === 'owner' || key === 'all') return { kind: key }
  const agents = activeAgents(ctx.project_id)
  const a = key === 'orchestrator' ? agents.find(x => x.role === 'orchestrator') : agents.find(x => x.name.toLowerCase() === key)
  if (!a) throw new Error(`No agent named "${t}". Crew: ${agents.map(x => x.name).join(', ')}, or "all", "orchestrator", "owner".`)
  if (a.id === ctx.agent_id) throw new Error('That is you.')
  return { kind: a.role === 'orchestrator' ? 'orchestrator' : 'agent', agent: a }
}

function post(ctx, { to, text }, kind = 'message') {
  const r = recipient(ctx, to)
  const base = { project_id: ctx.project_id, from_agent_id: ctx.agent_id, task_id: ctx.task_id, text: String(text), kind }
  if (r.kind === 'owner') {
    const m = addMessage({ ...base, to_owner: 1, delivered: 1 })
    const inbox = addInbox(ctx.project_id, 'question', `${nameOf(ctx.agent_id)}: ${m.text.slice(0, 90)}`, { body: m.text, run_id: ctx.run_id, task_id: ctx.task_id })
    return { m, inbox, text: 'Sent to the owner. Their answer comes back as a message.' }
  }
  if (r.kind === 'all') {
    const m = addMessage({ ...base, delivered: 1 })
    const reached = activeAgents(ctx.project_id).filter(a => a.id !== ctx.agent_id && deliver(m, a.id)).map(a => a.name)
    return { m, text: reached.length ? `Delivered to ${reached.join(', ')}.` : 'Posted. Nobody else is working right now; they can read it with crew_read.' }
  }
  const m = addMessage({ ...base, to_agent_id: r.agent.id })
  // A peer waiting on crew_ask for this sender gets this message as the answer.
  const wait = peerWaits.get(`${r.agent.id}:${ctx.agent_id}`)
  if (wait) { wait(m.text); return { m, text: `Delivered to ${r.agent.name}.` } }
  const live = r.kind === 'agent' && deliver(m, r.agent.id)
  if (live) markDelivered(m.id)
  return { m, live, text: live ? `Delivered to ${r.agent.name}.` : `${r.agent.name} is not working right now. It gets the message with its next task.` }
}

const markDelivered = id => run('UPDATE crew_messages SET delivered = 1 WHERE id = ?', id)

const timeout = (ms, value) => new Promise(r => setTimeout(() => r(value), ms).unref())

async function ask(ctx, { to, question }) {
  const r = recipient(ctx, to)
  const me = getAgent(ctx.agent_id), task = ctx.task_id ? getTask(ctx.task_id) : null
  if (r.kind === 'orchestrator') {
    addMessage({ project_id: ctx.project_id, from_agent_id: ctx.agent_id, to_agent_id: r.agent.id, task_id: ctx.task_id, text: String(question), kind: 'question', delivered: 1 })
    const answer = await askFromAgent(ctx.project_id, me, task, String(question))
    addMessage({ project_id: ctx.project_id, from_agent_id: r.agent.id, to_agent_id: ctx.agent_id, task_id: ctx.task_id, text: answer, kind: 'answer', delivered: 1 })
    return answer
  }
  if (r.kind === 'all') throw new Error('Ask one agent, "orchestrator" or "owner", not "all".')
  if (r.kind === 'owner') {
    const { inbox } = post(ctx, { to: 'owner', text: question }, 'question')
    const min = getProject(ctx.project_id).settings.question_timeout_min || 30
    const answer = await Promise.race([new Promise(res => ownerWaits.set(inbox, res)), timeout(min * 60000, null)])
    ownerWaits.delete(inbox)
    if (answer == null) { resolveInbox(inbox); return 'No answer yet. Decide yourself and state your assumption in the PR.' }
    return answer
  }
  if (!liveRunOf(r.agent.id)) {
    post(ctx, { to: r.agent.name, text: question }, 'question')
    return `${r.agent.name} is not working right now, so nobody can answer. Decide yourself, or ask "orchestrator".`
  }
  const key = `${ctx.agent_id}:${r.agent.id}`
  const answer = new Promise(res => peerWaits.set(key, res))
  post(ctx, { to: r.agent.name, text: question }, 'question')
  const out = await Promise.race([answer, timeout(PEER_WAIT_MS, null)])
  peerWaits.delete(key)
  return out ?? `${r.agent.name} did not answer within 10 minutes. Decide yourself and state your assumption in the PR.`
}

function read(ctx) {
  const run = get('SELECT started_at FROM runs WHERE id = ?', ctx.run_id)
  const rows = all(`SELECT * FROM crew_messages WHERE project_id = ? AND (from_agent_id IS NULL OR from_agent_id != ?) AND (
      (task_id IS NOT NULL AND task_id = ?) OR
      (created_at >= ? AND (to_agent_id = ? OR (to_agent_id IS NULL AND to_owner = 0))))
    ORDER BY id DESC LIMIT 50`, ctx.project_id, ctx.agent_id ?? 0, ctx.task_id ?? 0, run.started_at, ctx.agent_id ?? 0)
  if (!rows.length) return 'No messages for you.'
  return rows.reverse().map(m => `#${m.id} ${m.created_at} ${nameOf(m.from_agent_id)} to ${m.to_owner ? 'the owner' : m.to_agent_id ? nameOf(m.to_agent_id) : 'all'}${m.task_id ? ` (task #${m.task_id})` : ''}: ${m.text}`).join('\n')
}

function taskStatus(ctx, { task_id } = {}) {
  const mine = ctx.task_id && getTask(ctx.task_id)
  const tasks = task_id ? [getTask(Number(task_id))].filter(t => t?.project_id === ctx.project_id)
    : mine ? all('SELECT * FROM tasks WHERE order_id = ? ORDER BY id', mine.order_id) : []
  if (!tasks.length) return 'No tasks found.'
  return tasks.map(t => [
    `#${t.id} ${t.plan_key || ''} "${t.title}": ${t.status}${t.merged ? ', merged' : ''}${t.id === ctx.task_id ? ' (yours)' : ''}`,
    t.branch && `  branch ${t.branch}`, t.pr_url && `  PR ${t.pr_url}`,
    t.result && `  result: ${t.result.slice(0, 2000)}`,
  ].filter(Boolean).join('\n')).join('\n\n')
}

const CALLS = {
  crew_post: (ctx, a) => post(ctx, a).text,
  crew_ask: ask,
  crew_read: read,
  crew_task_status: taskStatus,
  service_start: async (ctx, { name, command }) => {
    const { service: s, already } = startService(ctx.project_id, { name, command })
    if (already) return `"${s.name}" is already running (${s.command})${s.url ? ` at ${s.url}` : ''}.`
    // Most dev servers print their URL within a few seconds; report it if it shows up.
    for (let i = 0; i < 16 && !serviceRow(s.id)?.url && serviceRow(s.id)?.status === 'running'; i++) await timeout(500)
    const now = serviceRow(s.id)
    if (now.status !== 'running') return `"${s.name}" exited right away (code ${now.exit_code}). Last output:\n${serviceText(s.id, 30)}`
    return `Started "${s.name}"${now.url ? ` at ${now.url}` : ' (no URL printed yet; check service_logs)'}.`
  },
  service_stop: (ctx, { name }) => {
    const s = get(`SELECT * FROM services WHERE project_id = ? AND name = ? AND status = 'running'`, ctx.project_id, String(name))
    if (!s) return `No running service named "${name}".`
    stopService(s.id)
    return `Stopping "${s.name}".`
  },
  service_list: ctx => {
    const rows = listServices(ctx.project_id)
    return rows.length ? rows.map(s => `${s.name}: ${s.status}${s.url ? ` ${s.url}` : ''} (${s.command})`).join('\n') : 'No services.'
  },
  service_logs: (ctx, { name, lines = 60 }) => {
    const s = get('SELECT * FROM services WHERE project_id = ? AND name = ? ORDER BY id DESC', ctx.project_id, String(name))
    return s ? serviceText(s.id, Number(lines) || 60) || '(no output yet)' : `No service named "${name}".`
  },
  suggest_order: (ctx, { text }) => suggestOrder(ctx, text),
  vault_search: (ctx, { query }) => describeHits(searchVault(ctx.project_id, query)),
  vault_read: (ctx, { id }) => readForAgent(ctx.project_id, id),
  vault_write: (ctx, { title, body, tags }) => {
    if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) throw new Error('title and body are required')
    const tagList = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').slice(0, 8) : []
    const r = addEntry(ctx.project_id, { kind: 'decision', title, body, tags: tagList, author_agent_id: ctx.agent_id })
    return `Saved as vault #${r.id}.`
  },
}

// Inbox "question:answer" for an item raised by an agent. True when it was such an item.
export function answerFromOwner(item, text) {
  const wait = ownerWaits.get(item.id)
  if (wait) { wait(text); return true }
  if (!item.run_id) return false
  // The asker gave up waiting or only posted: the answer still reaches it, now or with its next task.
  const run = get('SELECT agent_id, task_id, project_id FROM runs WHERE id = ?', item.run_id)
  if (!run?.agent_id) return false
  const m = addMessage({ project_id: run.project_id, from_agent_id: null, to_agent_id: run.agent_id, task_id: run.task_id, text, kind: 'answer' })
  if (deliver(m, run.agent_id)) markDelivered(m.id)
  return true
}

// Messages that never reached a live session, prepended to the agent's next task prompt.
export function takeQueued(agent_id) {
  const rows = all('SELECT * FROM crew_messages WHERE to_agent_id = ? AND delivered = 0 ORDER BY id', agent_id)
  for (const m of rows) markDelivered(m.id)
  // A message about a task that already passed or was merged is stale; answering it only burns tokens.
  const fresh = rows.filter(m => !m.task_id || getTask(m.task_id)?.status !== 'done')
  return fresh.map(m => `- ${nameOf(m.from_agent_id)}${m.task_id ? ` (task #${m.task_id})` : ''}: ${m.text}`).join('\n')
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const rpc = (res, id, result) => res.json({ jsonrpc: '2.0', id, result })
const rpcError = (res, id, code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } })

export async function mcpHandler(req, res) {
  // Agents run on this host; the token in the URL is also in the process list, so nobody else may use it.
  if (!LOOPBACK.includes(req.socket.remoteAddress)) return res.status(403).end()
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return res.status(403).end()
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end()
  const ctx = runForToken(req.params.token)
  if (!ctx) return res.status(401).json({ error: 'unknown or expired run token' })
  const m = req.body
  if (!m || typeof m !== 'object' || Array.isArray(m)) return res.status(400).end()
  if (m.id === undefined || m.id === null) return res.status(202).end()
  const tools = ctx.tools || []
  if (m.method === 'initialize') {
    return rpc(res, m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'crew', version: '2.0.0' } })
  }
  if (m.method === 'ping') return rpc(res, m.id, {})
  if (m.method === 'tools/list') return rpc(res, m.id, { tools: tools.map(name => ({ name, ...TOOLS[name] })) })
  if (m.method === 'tools/call') {
    const name = m.params?.name
    if (!tools.includes(name)) return rpcError(res, m.id, -32602, `Unknown tool ${name}`)
    try {
      const text = await CALLS[name](ctx, m.params.arguments || {})
      return rpc(res, m.id, { content: [{ type: 'text', text: String(text) }] })
    } catch (e) {
      return rpc(res, m.id, { content: [{ type: 'text', text: e.message }], isError: true })
    }
  }
  return rpcError(res, m.id, -32601, `Method not found: ${m.method}`)
}
