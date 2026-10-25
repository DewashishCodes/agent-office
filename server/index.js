import express from 'express'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, openSync, fstatSync, readSync, closeSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { all, get, run, insert, update, getProject, getAgent, getTask, getOrder, activeAgents, setTask, setAgent, log, resolveInbox, now, DATA_DIR } from './db.js'
import { teeConsole } from './logfile.js'
import { bus, emit } from './bus.js'
import { TEMPLATES, FLOORS, FLOOR_TEAMS, floorOf, template, createAgent, openFloor } from './roster.js'
import { killProject, killRun, tokensToday, projectTokensToday, projectCostToday, sendToRun, interruptRun, resumeRun, handoffRun, answerPermission, getRunEvents,
  hookEvent, watchPty, ptyInput, ptyResize, ptyLogPath } from './runner.js'
import { repoInfo, mergePR, inspectFolder, initRepo, createRepoFromFolder, ensureClone, pullDefault, listBranches, prDiff } from './github.js'
import { startInterview, askOnboarding, applyProposal } from './onboarding.js'
import { chat, chatFor, newChat, revisePlan, approvePlan, rejectPlan } from './orchestrator.js'
import { start, kick, markMerged, mergeTask, markOnboarded, cancelOrder, cancelTask, resolveConflicts, resumeChecks, removeAgent, pauseAgent, resumeAgent } from './scheduler.js'
import { initNotify, publicKey } from './notify.js'
import { mcpHandler, answerFromOwner } from './crewmcp.js'
import { matchAgent, loginLimiter, rememberPattern, estimates } from './rules.js'
import { listVault, getEntry, addEntry, updateEntry, deleteEntry, addFile, filePath, repoDocs, readDoc } from './vault.js'
import { askSupport, ensureSupport, supportAgent } from './support.js'
import { listServices, stopService, restartService, removeService, watchService, serviceTail, recoverServices, stopAllServices } from './services.js'

// First boot (or the example value): make the owner token, keep it in .env and say it once, instead of refusing to start.
if (!process.env.OWNER_TOKEN || process.env.OWNER_TOKEN === 'change-me-to-a-long-random-string') {
  const env = join(import.meta.dirname, '..', '.env')
  const token = randomBytes(24).toString('base64url')
  const old = existsSync(env) ? readFileSync(env, 'utf8') : ''
  writeFileSync(env, /^OWNER_TOKEN=.*$/m.test(old)
    ? old.replace(/^OWNER_TOKEN=.*$/m, `OWNER_TOKEN=${token}`)
    : `${old}${old && !old.endsWith('\n') ? '\n' : ''}OWNER_TOKEN=${token}\n`)
  process.env.OWNER_TOKEN = token
  console.log(`\nNo owner token was set, so one was made and saved in .env. Log in with:\n\n  ${token}\n\nat http://localhost:${process.env.PORT || 5190} (from your phone, see Phone access in the README).\n`)
}

const sha = s => createHash('sha256').update(s).digest()
const MAX_AGE = 30 * 24 * 3600 * 1000
// Looked up by its hash, so the comparison never runs on bytes the client chose.
const sessionId = req => sha((req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('crew='))?.slice(5) || '').toString('hex')
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

const count = (min, max = Infinity) => v => Number.isInteger(v) && v >= min && v <= max
const regex = v => { try { return typeof v === 'string' && v.length < 4000 && !!new RegExp(v) } catch { return false } }
// A bad value here (an invalid regex above all) would break every permission check, so each key is checked.
const SETTINGS = {
  protected_paths: isStrs,
  autonomy: count(1, 1),
  plan_approval_small: v => typeof v === 'boolean',
  digest_hour: v => v === null || count(0, 23)(v),
  project_daily_token_budget: count(0),
  project_daily_cost_budget: v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0),
  permission_timeout_min: count(1, 24 * 60),
  question_timeout_min: count(1, 24 * 60),
  auto_allow_bash: regex,
}

function profileFields(body) {
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE[k]) throw fail(400, `${k} is not editable`)
    if (!EDITABLE[k](v)) throw fail(400, `invalid ${k}`)
  }
  return body
}

// "Allow, don't ask again": checked before the answer so a refused pattern leaves the request open for a plain Allow.
function answer(run_id, request_id, allow, { message, remember } = {}) {
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

// A retry goes ahead without dependencies the owner canceled; they would never finish. A note from the owner keeps
// the last failure with it, so the agent sees both what went wrong and how the owner wants it fixed.
function retryTask(id, note) {
  const old = getTask(id)
  const deps = old.depends_on.filter(d => getTask(d)?.status !== 'canceled')
  const notes = note ? `${old.notes ? `${old.notes}\n\n` : ''}From the owner: ${note}` : ''
  const t = setTask(id, { attempts: 0, notes, status: 'planned', depends_on: deps })
  kick()
  return t
}

export const app = express()
// Only a local proxy (Tailscale Serve) may set X-Forwarded-*; otherwise a client could pick its own IP for the login limit.
app.set('trust proxy', 'loopback')

// Hooks and the status line of terminal runs (server/hook.mjs). Same trust as the crew MCP: loopback plus the per-run token.
// Before the global parser: a PermissionRequest for a big Write carries the whole file.
app.post('/hook/:token', express.json({ limit: '50mb' }), async (req, res) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.status(403).end()
  const out = await hookEvent(req.params.token, req.query.kind, req.body)
  if (typeof out === 'string') res.type('text').send(out)
  else res.json(out)
})

app.use(express.json({ limit: '1mb' }))

// Crew MCP for agent sessions on this host; auth is the per-run token, not the owner cookie.
app.all('/mcp/:token', mcpHandler)

const logins = loginLimiter()
app.post('/api/login', (req, res) => {
  if (logins.blocked(req.ip)) throw fail(429, 'too many wrong tokens, try again in 15 minutes')
  const token = req.body?.token
  if (typeof token !== 'string' || !timingSafeEqual(sha(token), sha(process.env.OWNER_TOKEN))) {
    logins.miss(req.ip)
    throw fail(401, 'wrong token')
  }
  logins.clear(req.ip)
  const sid = randomBytes(32).toString('hex')
  run('INSERT INTO sessions (id) VALUES (?)', sha(sid).toString('hex'))
  res.cookie('crew', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE })
  res.json({ ok: true })
})

// Health for a service manager or a curl on this machine: loopback without a cookie, everyone else logs in first.
// Tailscale Serve proxies from loopback too, so a forwarded request is not local.
const health = (req, res) => res.json({
  ok: true, uptime: Math.round(process.uptime()), projects: get('SELECT COUNT(*) n FROM projects').n,
  running_runs: get(`SELECT COUNT(*) n FROM runs WHERE status = 'running'`).n,
})
app.get('/api/health', (req, res, next) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] ? health(req, res) : next())

app.use('/api', (req, res, next) => {
  if (!get(`SELECT 1 FROM sessions WHERE id = ? AND created_at > datetime('now', ?)`, sessionId(req), `-${MAX_AGE / 1000} seconds`)) throw fail(401, 'not logged in')
  next()
})

// running stays 1 in kv until a clean exit, so the next boot knows the last one crashed, lost power or slept.
const booted = Date.now(), unclean = get(`SELECT value FROM kv WHERE key = 'running'`)?.value === '1'
// restarted: an unclean restart under a minute ago, for a one-line hint in the UI.
app.get('/api/health', health)

// A consistent copy of the whole database: VACUUM INTO snapshots it even while runs write, then it streams and goes.
app.get('/api/backup', (req, res) => {
  const file = join(DATA_DIR, `backup-${Date.now()}.db`)
  run('VACUUM INTO ?', file)
  res.download(file, `agent-office-${new Date().toLocaleDateString('sv')}.db`, () => rmSync(file, { force: true }))
})

app.get('/api/me', (req, res) => res.json({ ok: true, restarted: unclean && Date.now() - booted < 60000 }))
// all: true signs out every browser and phone, for a lost device or a leaked cookie.
app.post('/api/logout', (req, res) => {
  if (req.body?.all) run('DELETE FROM sessions')
  else run('DELETE FROM sessions WHERE id = ?', sessionId(req))
  res.clearCookie('crew')
  res.json({ ok: true })
})

// Projects

app.get('/api/projects', (req, res) => res.json(all('SELECT * FROM projects ORDER BY id')))

// Folder browser for the new project wizard: the owner picks folders on this PC from the phone.
app.get('/api/fs/dirs', (req, res) => {
  const raw = req.query.path
  if (!raw) {
    const drives = process.platform === 'win32' ? [...'CDEFGHIJ'].map(d => `${d}:\\`).filter(d => existsSync(d)) : ['/']
    return res.json({ path: null, parent: null, dirs: [homedir(), ...drives] })
  }
  const path = resolve(String(raw))
  let dirs
  try { dirs = readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map(e => e.name) }
  catch { throw fail(400, `cannot open ${path}`) }
  const parent = dirname(path)
  res.json({ path, parent: parent === path ? null : parent, dirs: dirs.sort((a, b) => a.localeCompare(b)) })
})

const absPath = v => { if (typeof v !== 'string' || !isAbsolute(v)) throw fail(400, 'path must be an absolute folder path'); return resolve(v) }
const repoName = v => String(v || '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90)

app.post('/api/projects/inspect', async (req, res) => res.json(await inspectFolder(absPath(req.body?.path))))

// Three doors: a GitHub repo, an existing folder (a private repo is created from it when it has no GitHub remote, after
// the owner confirmed), or a blank folder with the owner's idea or PRD. The crew always works in its own clone.
app.post('/api/projects', async (req, res) => {
  const b = req.body ?? {}
  const source = b.source || 'github'
  let repo, source_path = null
  if (source === 'github') {
    repo = b.repo
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail(400, 'repo must be owner/name')
  } else if (source === 'local') {
    const info = await inspectFolder(absPath(b.path))
    if (!info.exists) throw fail(400, `${info.path} is not a folder`)
    source_path = info.path
    repo = info.repo
    if (!repo) {
      if (b.create_repo !== true) throw fail(400, 'This folder has no GitHub remote. Confirm creating a private repo for it.')
      if (!info.commits) await initRepo(info.path)
      repo = await createRepoFromFolder(info.path, repoName(b.name || info.name))
    }
  } else if (source === 'blank') {
    const name = str(b.name, 'name'), prd = str(b.prd, 'prd')
    const folder = repoName(b.folder || name)
    if (!folder) throw fail(400, 'folder name is required')
    source_path = join(absPath(b.parent), folder)
    if (existsSync(source_path) && readdirSync(source_path).length) throw fail(409, `${source_path} already exists and is not empty`)
    mkdirSync(source_path, { recursive: true })
    await initRepo(source_path, { 'docs/PRD.md': `${prd.trim()}\n`, 'README.md': `# ${name}\n\nSee docs/PRD.md.\n` })
    repo = await createRepoFromFolder(source_path, folder)
  } else throw fail(400, 'source must be github, local or blank')
  if (get('SELECT id FROM projects WHERE repo = ?', repo)) throw fail(409, `${repo} is already a project`)
  const info = await repoInfo(repo)
  const id = insert('projects', { name: b.name?.trim() || info.name, repo, default_branch: info.default_branch, source, source_path })
  supportAgent(id)
  background(id, startInterview(id))
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
    cost_today: projectCostToday(p.id),
    rate_limit: rl ? JSON.parse(rl) : null,
  })
})

app.get('/api/projects/:id/branches', async (req, res) => {
  const p = project(req)
  await ensureClone(p)
  res.json({ current: p.default_branch, branches: await listBranches(getProject(p.id)) })
})

app.patch('/api/projects/:id', async (req, res) => {
  const p = project(req)
  const { name, settings, default_branch, ...rest } = req.body ?? {}
  if (Object.keys(rest).length) throw fail(400, `${Object.keys(rest)[0]} is not editable`)
  const f = {}
  if (name !== undefined) f.name = str(name, 'name')
  // The working branch: new tasks start from it, PRs target it and hotfixes push to it. Running tasks keep their base.
  if (default_branch !== undefined && default_branch !== p.default_branch) {
    await ensureClone(p)
    if (!(await listBranches(getProject(p.id))).includes(default_branch)) throw fail(400, `no branch ${default_branch} on GitHub`)
    await pullDefault({ ...getProject(p.id), default_branch })
    f.default_branch = default_branch
  }
  if (settings !== undefined) {
    if (!isObj(settings)) throw fail(400, 'settings must be an object')
    for (const [k, v] of Object.entries(settings)) {
      if (!SETTINGS[k]) throw fail(400, `${k} is not a setting`)
      if (!SETTINGS[k](v)) throw fail(400, `invalid ${k}`)
    }
    f.settings = { ...p.settings, ...settings }
  }
  update('projects', p.id, f)
  const out = getProject(p.id)
  emit('project', p.id, out)
  res.json(out)
})

// Re-run onboarding (also the retry after a failure): a new interview with the current office in the prompt.
app.post('/api/projects/:id/onboard', (req, res) => {
  const p = project(req)
  if (p.onboarding_status === 'running') throw fail(409, 'Onboarding is writing the crew docs right now')
  background(p.id, startInterview(p.id, { rerun: !['pending', 'failed'].includes(p.onboarding_status) || !!p.rerun }))
  res.status(202).json({ ok: true })
})

app.get('/api/projects/:id/onboarding', (req, res) => {
  const p = project(req)
  res.json({ messages: all(`SELECT * FROM messages WHERE project_id = ? AND channel = 'onboarding' ORDER BY id`, p.id), proposal: p.proposal, status: p.onboarding_status })
})

app.post('/api/projects/:id/onboarding', (req, res) => {
  const p = project(req)
  if (!['interviewing', 'proposed'].includes(p.onboarding_status)) throw fail(409, 'Onboarding is not in an interview. Re-run it first.')
  background(p.id, askOnboarding(p.id, str(req.body?.text, 'text')))
  res.status(202).json({ ok: true })
})

app.post('/api/projects/:id/onboarding/apply', (req, res) => {
  const p = project(req), keep = req.body?.keep ?? []
  if (!Array.isArray(keep) || !keep.every(Number.isInteger)) throw fail(400, 'keep must be a list of agent indexes')
  try { background(p.id, applyProposal(p.id, keep)) } catch (e) { throw fail(409, e.message) }
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

app.get('/api/projects/:id/chats', (req, res) => res.json(all(`SELECT c.*, (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) messages
  FROM chats c WHERE project_id = ? AND floor = ? ORDER BY updated_at DESC, id DESC LIMIT 100`, project(req).id, floorKey(req.query.floor))))

app.get('/api/projects/:id/messages', (req, res) => {
  if (req.query.chat) return res.json(all('SELECT * FROM messages WHERE project_id = ? AND chat_id = ? ORDER BY id', project(req).id, int(req.query.chat)))
  const support = req.query.channel === 'support'
  res.json(all(`SELECT * FROM (SELECT * FROM messages WHERE project_id = ? AND channel = ?${support ? '' : ' AND floor = ?'} ORDER BY id DESC LIMIT 200) ORDER BY id`,
    project(req).id, ...(support ? ['support'] : ['command', floorKey(req.query.floor)])))
})

const floorKey = v => v == null || v === '' ? 'tech' : floorOf(v)?.key ?? (() => { throw fail(400, `unknown floor ${v}`) })()

app.post('/api/projects/:id/messages', (req, res) => {
  const p = project(req), floor = floorKey(req.body?.floor)
  if (!activeAgents(p.id).some(a => a.floor === floor && a.role === 'orchestrator')) throw fail(400, `The ${floorOf(floor).name} floor has no lead. Open the floor first.`)
  const text = str(req.body?.text, 'text')
  // Without chat_id the message starts a new chat; its id goes back so the screen can follow it.
  const chat_id = req.body?.chat_id == null ? newChat(p.id, floor, text)
    : found(get('SELECT id FROM chats WHERE id = ? AND project_id = ? AND floor = ?', int(req.body.chat_id), p.id, floor), 'chat').id
  background(p.id, chat(p.id, text, floor, 'user', chat_id, req.body?.hotfix === true))
  res.status(202).json({ ok: true, chat_id })
})

// What an order has cost so far: every run of its tasks, review and QA included.
const ORDER_COST = `(SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE order_id = o.id)) cost_usd`

app.get('/api/projects/:id/orders', (req, res) => res.json(all(`SELECT o.*, ${ORDER_COST},
  (SELECT COUNT(*) FROM tasks WHERE order_id = o.id) total, (SELECT COUNT(*) FROM tasks WHERE order_id = o.id AND status = 'done') done
  FROM orders o WHERE project_id = ? ORDER BY id DESC`, project(req).id)))

const order = req => found(getOrder(int(req.params.id)), 'order')

app.get('/api/orders/:id', (req, res) => {
  const o = order(req)
  // A plan waiting for approval gets estimates per size from this project's finished tasks.
  const est = o.status === 'awaiting_approval' && estimates(all(`SELECT t.size, SUM(r.input_tokens + r.output_tokens) tokens, SUM(r.cost_usd) cost
    FROM tasks t JOIN runs r ON r.task_id = t.id WHERE t.project_id = ? AND (t.status = 'done' OR t.merged = 1) GROUP BY t.id`, o.project_id))
  res.json({ ...get(`SELECT ${ORDER_COST} FROM orders o WHERE id = ?`, o.id), ...o, estimates: est || null, tasks: all('SELECT * FROM tasks WHERE order_id = ? ORDER BY id', o.id) })
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

app.post('/api/orders/:id/cancel', (req, res) => {
  const o = order(req)
  if (['done', 'rejected', 'canceled'].includes(o.status)) throw fail(409, `That order is already ${o.status}`)
  cancelOrder(o.id)
  res.json({ ok: true })
})

// Merge every PR of the order in the order the integration check asked for (its merge cards), stopping at the first failure.
app.post('/api/orders/:id/merge', async (req, res) => {
  const o = order(req)
  const cards = all(`SELECT task_id FROM inbox WHERE order_id = ? AND kind = 'merge' AND task_id IS NOT NULL ORDER BY id`, o.id).map(i => i.task_id)
  const tasks = all('SELECT id FROM tasks WHERE order_id = ? AND pr_number IS NOT NULL AND merged = 0 AND status = ? ORDER BY id', o.id, 'done').map(t => t.id)
  const ordered = [...cards.filter(id => tasks.includes(id)), ...tasks.filter(id => !cards.includes(id))]
  const merged = []
  for (const id of ordered) {
    try { await mergeTask(id); merged.push(id) } catch (e) {
      return res.status(409).json({ error: `Merged ${merged.length} of ${ordered.length}. "${getTask(id).title}" failed: ${e.message}`, merged })
    }
  }
  res.json({ merged })
})

app.post('/api/orders/:id/reject', async (req, res) => {
  await rejectPlan(order(req).id)
  res.json({ ok: true })
})

// Tasks

// What the office delivered: merged tasks newest first, each with its agent, order and total run cost.
app.get('/api/projects/:id/shipped', (req, res) => {
  res.json(all(`SELECT t.id, t.title, t.pr_number, t.pr_url, t.order_id, COALESCE(t.merged_at, t.updated_at) merged_at, a.name agent_name,
    COALESCE(o.plan ->> '$.summary', o.text) order_title,
    (SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE task_id = t.id) cost_usd,
    (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM runs WHERE task_id = t.id) tokens
    FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN orders o ON o.id = t.order_id
    WHERE t.project_id = ? AND t.merged = 1 ORDER BY merged_at DESC, t.id DESC LIMIT 300`, project(req).id))
})

app.get('/api/projects/:id/tasks', (req, res) => {
  const p = project(req), { agent_id, order_id } = req.query
  let sql = 'SELECT t.*, a.name agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.project_id = ?'
  const params = [p.id]
  if (agent_id) sql += ' AND t.agent_id = ?', params.push(int(agent_id))
  if (order_id) sql += ' AND t.order_id = ?', params.push(int(order_id))
  res.json(all(sql + ' ORDER BY t.id', ...params))
})

// Direct task: a one-task order for a named agent, no plan round trip. Reviewer and QA still run, unless it is a hotfix.
app.post('/api/projects/:id/tasks', (req, res) => {
  const p = project(req)
  const { agent: name, title, description = '', acceptance = [], files = [], hotfix = false } = req.body ?? {}
  str(title, 'title')
  if (typeof description !== 'string' || !isStrs(acceptance) || !isStrs(files)) throw fail(400, 'description must be text, acceptance and files lists of text')
  const a = activeAgents(p.id).find(x => x.name === str(name, 'agent'))
  if (!a?.owned_paths.length) throw fail(400, `${name} is not an agent that owns paths`)
  if (!matchAgent([a], { files })) throw fail(400, `${a.name} does not own ${files.join(', ')}`)
  const spec = { key: 't1', title, agent: a.name, description, acceptance, files, size: 'S', depends_on: [] }
  const order_id = insert('orders', { project_id: p.id, text: title, status: 'in_progress', plan: { summary: title, direct: true, tasks: [spec] }, hotfix: hotfix === true })
  const task_id = insert('tasks', { project_id: p.id, order_id, plan_key: 't1', title, description, role: a.role, plan_agent: a.name, acceptance, files, size: 'S', agent_id: a.id })
  emit('order', p.id, getOrder(order_id))
  log(p.id, 'order', `${hotfix === true ? 'Hotfix' : 'Quick task'} for ${a.name}: ${title}`, { order_id, task_id, agent_id: a.id })
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

app.get('/api/tasks/:id/diff', async (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  if (!t.pr_number) throw fail(404, 'This task has no pull request yet')
  try { res.json({ diff: await prDiff(getProject(t.project_id), t.pr_number) }) } catch (e) { throw fail(502, e.message) }
})

app.post('/api/tasks/:id/resolve', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  try { res.json(resolveConflicts(t.id)) } catch (e) { throw fail(409, e.message) }
})

app.post('/api/tasks/:id/cancel', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  try { res.json(cancelTask(t.id)) } catch (e) { throw fail(409, e.message) }
})

app.post('/api/tasks/:id/retry', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  const note = req.body?.note
  if (note !== undefined && typeof note !== 'string') throw fail(400, 'note must be text')
  res.json(retryTask(t.id, note?.trim().slice(0, 4000)))
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
  const orders = all(`SELECT o.*, ${ORDER_COST} FROM orders o WHERE project_id = ? AND status NOT IN ('done', 'rejected', 'canceled') ORDER BY id DESC`, p.id).map(o => ({
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

// Support desk and its services

app.post('/api/projects/:id/support', (req, res) => {
  const p = project(req), { text, model } = req.body ?? {}
  if (model !== undefined && !['haiku', 'sonnet', 'opus'].includes(model)) throw fail(400, 'model must be haiku, sonnet or opus')
  background(p.id, askSupport(p.id, str(text, 'text'), { model }))
  res.status(202).json({ ok: true })
})

app.get('/api/projects/:id/services', (req, res) => res.json(listServices(project(req).id)))

const service = req => found(get('SELECT * FROM services WHERE id = ?', int(req.params.id)), 'service')

app.post('/api/services/:id/stop', (req, res) => res.json(stopService(service(req).id)))
app.post('/api/services/:id/restart', async (req, res) => res.json(await restartService(service(req).id)))
app.delete('/api/services/:id', (req, res) => {
  try { removeService(service(req).id) } catch (e) { throw fail(409, e.message) }
  res.json({ ok: true })
})

// Service output as SSE, same shape as a run's terminal.
app.get('/api/services/:id/log', (req, res) => {
  const s = service(req)
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`)
  const end = () => { res.write('event: end\ndata: {}\n\n'); res.end() }
  const stop = watchService(s.id, d => d === null ? end() : send(d))
  if (!stop) { send(serviceTail(s.id)); return end() }
  const beat = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { clearInterval(beat); stop() })
})

// Vault

const entry = req => found(getEntry(int(req.params.id)), 'vault entry')
const tagsOf = v => (isStrs(v) ? v.map(t => t.trim()).filter(Boolean).slice(0, 12) : [])

app.get('/api/projects/:id/vault', (req, res) => {
  const p = project(req)
  res.json({ docs: repoDocs(p), items: listVault(p.id) })
})

app.get('/api/projects/:id/vault/doc', async (req, res) => {
  const text = await readDoc(project(req), String(req.query.path || ''))
  if (text == null) throw fail(404, 'document not found')
  res.json({ path: req.query.path, text })
})

app.post('/api/projects/:id/vault', (req, res) => {
  const p = project(req), { kind = 'note', title, body = '', tags } = req.body ?? {}
  if (!['note', 'decision'].includes(kind)) throw fail(400, 'kind must be note or decision')
  if (typeof body !== 'string') throw fail(400, 'body must be text')
  res.json(addEntry(p.id, { kind, title: str(title, 'title'), body, tags: tagsOf(tags) }))
})

// Raw body upload sent as application/octet-stream (a JSON file would otherwise hit the JSON parser); name and type in the query.
app.post('/api/projects/:id/vault/files', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const p = project(req)
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'empty file, or not sent as application/octet-stream')
  const type = typeof req.query.type === 'string' ? req.query.type.slice(0, 100) : null
  res.json(addFile(p.id, str(req.query.name, 'name'), type, req.body))
})

app.get('/api/vault/:id', (req, res) => res.json(entry(req)))

app.get('/api/vault/:id/file', (req, res) => {
  const e = entry(req)
  if (!e.file) throw fail(404, 'no file')
  res.download(filePath(e), e.title)
})

app.patch('/api/vault/:id', (req, res) => {
  const e = entry(req), { title, body, tags } = req.body ?? {}
  const fields = {}
  if (title !== undefined) fields.title = str(title, 'title').trim().slice(0, 200)
  if (body !== undefined) { if (typeof body !== 'string' || e.kind === 'file') throw fail(400, 'body must be text, files keep theirs'); fields.body = body }
  if (tags !== undefined) fields.tags = tagsOf(tags)
  res.json(updateEntry(e.id, fields))
})

app.delete('/api/vault/:id', (req, res) => {
  deleteEntry(entry(req).id)
  res.json({ ok: true })
})

// Agents

app.get('/api/templates', (req, res) => res.json([...TEMPLATES.map(t => ({ ...t, floor: 'tech' })), ...Object.values(FLOOR_TEAMS).flat()]))

app.get('/api/floors', (req, res) => res.json(FLOORS))

// Opening a floor hires its lead, workers and reviewer.
app.post('/api/projects/:id/floors', (req, res) => {
  const p = project(req), key = floorKey(req.body?.floor)
  if (!FLOOR_TEAMS[key]) throw fail(400, 'That floor is always open')
  if (activeAgents(p.id).some(a => a.floor === key)) throw fail(409, `The ${floorOf(key).name} floor is already open`)
  const hired = openFloor(p.id, key)
  for (const a of hired) emit('agent', p.id, a)
  log(p.id, 'floor', `${floorOf(key).name} floor opened with ${hired.map(a => a.name).join(', ')}`)
  res.json(hired)
})

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
  const { role, floor, ...fields } = req.body ?? {}
  profileFields(fields)
  let base = { role: 'custom' }
  if (role !== undefined && role !== 'custom') base = found(template(role), 'template')
  const a = { ...base, ...fields }
  if (floor !== undefined || !a.floor) a.floor = floorKey(floor)
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
  const copy = { role: a.role, floor: a.floor }
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
  // Every PR goes through its floor's reviewer (and QA on Tech), so the last one of each on a floor stays.
  if (['reviewer', 'qa'].includes(a.role) && activeAgents(a.project_id).filter(x => x.role === a.role && x.floor === a.floor).length < 2)
    throw fail(400, `${a.name} is the only ${a.role} agent on this floor. Add another one first, or pause it instead.`)
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
    ? all(`SELECT * FROM inbox WHERE project_id = ? AND status = ? ORDER BY id ${status === 'open' ? 'ASC' : 'DESC'}`, p.id, status)
    : all('SELECT * FROM inbox WHERE project_id = ? ORDER BY id DESC', p.id))
})

app.post('/api/inbox/:id/action', async (req, res) => {
  const item = found(get('SELECT * FROM inbox WHERE id = ?', int(req.params.id)), 'inbox item')
  if (item.status !== 'open') throw fail(409, 'already resolved')
  const { action, text, remember } = req.body ?? {}
  const key = `${item.kind}:${action}`
  let status = 200
  if (item.kind === 'permission') {
    if (!['allow', 'deny', 'dismiss'].includes(action)) throw fail(400, `unknown action ${action} for permission`)
    // A run that already ended leaves nothing to answer; the item still closes.
    try { answer(item.run_id, item.ref, action === 'allow', { message: typeof text === 'string' && text.trim() ? text : undefined, remember: remember === true }) }
    catch (e) { if (e.status !== 400) resolveInbox(item.id); throw e }
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
      try { await mergeTask(found(getTask(item.task_id), 'task').id) } catch (e) { throw fail(409, e.message) }
    } else {
      await mergePR(p, found(p.onboarding_pr, 'onboarding pull request'))
      markOnboarded(p.id)
    }
  } else if (key === 'question:answer') {
    // Agent questions go back to the agent; anything else is a note for the Orchestrator.
    if (!answerFromOwner(item, str(text, 'text'))) {
      const floor = (item.order_id && getOrder(item.order_id)?.floor) || 'tech'
      background(item.project_id, chat(item.project_id, `Answer to "${item.title}": ${text}`, floor, 'user', chatFor(item.project_id, floor, item.order_id)))
      status = 202
    }
  } else if (key === 'merge:resolve') {
    try { resolveConflicts(found(getTask(item.task_id), 'task').id) } catch (e) { throw fail(409, e.message) }
  } else if (key === 'failure:retry') retryTask(found(item.task_id, 'task'), typeof text === 'string' ? text.trim().slice(0, 4000) : undefined)
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
// index.html names the hashed bundles, so it must be revalidated or a browser keeps running the previous build.
const fresh = res => res.setHeader('Cache-Control', 'no-cache')
app.use(express.static(DIST, { setHeaders: (res, p) => p.endsWith('.html') && fresh(res) }))
app.get('/{*any}', (req, res, next) => { fresh(res); res.sendFile(join(DIST, 'index.html'), e => e && next(fail(404, 'web app not built, run npm run build'))) })

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500) console.error(err)
  res.status(status).json({ error: status >= 500 && !err.message ? 'server error' : err.message })
})

if (import.meta.main) {
  // After the first-boot token message, so the token never lands in the log file.
  teeConsole(join(DATA_DIR, 'server.log'))
  const port = process.env.PORT || 5190
  // Boot recovery and the scheduler only start once the port is ours: a second server on the same data/ would
  // otherwise reset the first one's running tasks and start runs nobody can reach.
  // Express 5 calls this on a listen error too, with the error.
  app.listen(port, err => {
    if (err) {
      console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use: is Agent Office already running? Set PORT in .env to run a second copy.` : err.message)
      process.exit(1)
    }
    ensureSupport()
    recoverServices()
    run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('running', '1')`)
    // A crash exits non-zero and still fires 'exit'; only a clean stop clears the flag.
    process.on('exit', code => { stopAllServices(); if (code === 0) run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('running', '0')`) })
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))
    initNotify()
    start()
    console.log(`Agent Office on http://localhost:${port}`)
  })
}
