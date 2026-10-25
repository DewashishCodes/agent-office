import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { emit } from './bus.js'

export const DATA_DIR = process.env.CREW_DATA_DIR || join(import.meta.dirname, '..', 'data')
mkdirSync(DATA_DIR, { recursive: true })
// Clones and worktrees live under DATA_DIR; without this a project with no package.json of its own would inherit the
// crew's "type": "module" and load its CommonJS as ES modules.
if (!existsSync(join(DATA_DIR, 'package.json'))) writeFileSync(join(DATA_DIR, 'package.json'), '{}\n')

export const db = new DatabaseSync(process.env.CREW_DB || join(DATA_DIR, 'crew.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT NOT NULL UNIQUE,              -- "owner/name"
  default_branch TEXT NOT NULL DEFAULT 'main',
  local_path TEXT,                        -- clone under data/repos
  settings TEXT NOT NULL DEFAULT '{}',    -- JSON, see DEFAULT_SETTINGS
  orchestrator_session_id TEXT,           -- unused since v2: every Orchestrator request is a fresh session
  onboarding_status TEXT NOT NULL DEFAULT 'pending', -- pending | interviewing | proposed | running | pr_open | done | failed
  onboarding_pr INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,      -- kill switch state
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,                     -- orchestrator (a floor lead) | reviewer | qa | planner | frontend | backend | support | custom | a floor worker key
  specialty TEXT NOT NULL DEFAULT '',
  owned_paths TEXT NOT NULL DEFAULT '[]', -- JSON globs
  readonly_paths TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'sonnet',
  effort TEXT NOT NULL DEFAULT 'medium',
  max_parallel INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL DEFAULT '{}', -- JSON {open_pr, comment, run_tests, merge}
  daily_token_budget INTEGER NOT NULL DEFAULT 3000000,
  status TEXT NOT NULL DEFAULT 'idle',    -- idle | working | paused | blocked
  removable INTEGER NOT NULL DEFAULT 1,
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning', -- planning | awaiting_approval | in_progress | ready_to_merge | done | rejected | canceled
  plan TEXT,                               -- JSON plan from the Orchestrator, see CONTRACTS.md
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  order_id INTEGER REFERENCES orders(id),
  plan_key TEXT,                          -- the id the plan used, e.g. "t1"
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,                     -- role the plan asked for
  acceptance TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  size TEXT NOT NULL DEFAULT 'M',         -- S | M | L
  depends_on TEXT NOT NULL DEFAULT '[]',  -- JSON task ids (numbers)
  files TEXT NOT NULL DEFAULT '[]',       -- JSON paths/globs the task expects to touch
  agent_id INTEGER REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'planned', -- planned | in_progress | in_review | qa | done | blocked | canceled
  attempts INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',         -- feedback from Reviewer/QA/gate for the next attempt
  branch TEXT,
  worktree TEXT,
  base_sha TEXT,                          -- commit the agent started from; gate diffs from here
  issue_number INTEGER,
  pr_number INTEGER,
  pr_url TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,                     -- user | orchestrator | system | support
  text TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id), -- set when the message carries a plan card
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  agent_id INTEGER, order_id INTEGER, task_id INTEGER,
  kind TEXT NOT NULL,                     -- free-form tag: order, plan, dispatch, pr, review, qa, merge, gate, error, digest ...
  text TEXT NOT NULL,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                     -- plan | merge | question | failure
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  order_id INTEGER, task_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',    -- open | done
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  agent_id INTEGER, task_id INTEGER,
  kind TEXT NOT NULL,                     -- orchestrator | task | review | qa | onboarding | integrate
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | ok | error | killed
  last_event TEXT,                        -- short live status line, e.g. "Edit web/App.jsx"
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_text TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_notes (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  sub TEXT NOT NULL                       -- JSON PushSubscription
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (     -- owner logins; logout deletes the row so a copied cookie stops working
  id TEXT PRIMARY KEY,                    -- sha256 hex of the cookie value, so the database alone cannot log in
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chats (        -- Command conversations; the lead only sees its own chat as context
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  floor TEXT NOT NULL DEFAULT 'tech',
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,                     -- stream line type (assistant | user | result | system | control_request) or owner | note
  json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events (run_id, seq);
CREATE TABLE IF NOT EXISTS crew_messages (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  from_agent_id INTEGER,                  -- null = the owner
  to_agent_id INTEGER,                    -- null with to_owner 0 = everyone
  to_owner INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',   -- message | question | answer
  delivered INTEGER NOT NULL DEFAULT 0,   -- 1 once it reached a live session or a task prompt
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | stopped | exited
  url TEXT,                               -- first local URL the process printed
  exit_code INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS vault (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                     -- note (owner) | decision (agent or owner) | file (upload)
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',          -- the text; for a file its extracted text when it is text, else ''
  file TEXT,                              -- stored name under data/vault/<project_id>/
  mime TEXT,
  size INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON strings
  author_agent_id INTEGER,                -- null = the owner
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// CREATE TABLE IF NOT EXISTS never changes an existing table, so later columns are added here.
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
}
addColumn('runs', 'turn', 'INTEGER NOT NULL DEFAULT 0')
addColumn('runs', 'state', "TEXT NOT NULL DEFAULT 'running'")   // running | waiting | paused | handed_off, meaningful while status is running
addColumn('runs', 'pending_permission', 'TEXT')                 // JSON array of open can_use_tool requests, or null
addColumn('runs', 'terminal', 'INTEGER NOT NULL DEFAULT 0')                   // 1 = ran in a real terminal, replay from data/pty/run-<id>.log
addColumn('tasks', 'plan_agent', 'TEXT')                        // agent name the plan assigned; matchAgent prefers it
addColumn('tasks', 'result', 'TEXT')                            // final message of the last task run, handed to dependents
addColumn('tasks', 'merged_at', 'TEXT')                         // when the PR merged; older rows fall back to updated_at
addColumn('tasks', 'conflict', 'INTEGER NOT NULL DEFAULT 0')   // 1 = the PR conflicts with the project branch, 2 = the next run resolves it
addColumn('tasks', 'resume_session', 'TEXT')                    // session cut off by a restart; the next run resumes it
addColumn('tasks', 'checks', 'TEXT')                            // CI on the PR: pass | fail | pending | none, from the PR poll
addColumn('tasks', 'wait_reason', 'TEXT')                       // why a ready task is not starting, e.g. a file lock
addColumn('inbox', 'run_id', 'INTEGER')
addColumn('inbox', 'ref', 'TEXT')
addColumn('messages', 'channel', "TEXT NOT NULL DEFAULT 'command'")  // command (Orchestrator) | support
addColumn('messages', 'suggest', 'TEXT')                       // support: an order it suggests handing to the team                               // permission request_id
addColumn('agents', 'floor', "TEXT NOT NULL DEFAULT 'tech'")   // tech | design | docs | ... see roster.FLOORS
addColumn('orders', 'floor', "TEXT NOT NULL DEFAULT 'tech'")   // the floor whose lead planned it
addColumn('messages', 'floor', "TEXT NOT NULL DEFAULT 'tech'") // command chat is per floor
addColumn('projects', 'source', "TEXT NOT NULL DEFAULT 'github'") // github | local | blank: how the project came in
addColumn('projects', 'source_path', 'TEXT')                    // the owner's own folder; local_path is the crew clone
addColumn('projects', 'proposal', 'TEXT')                       // JSON office proposal from the Onboarding agent
addColumn('projects', 'rerun', 'INTEGER NOT NULL DEFAULT 0')    // 1 while a re-run of onboarding is in progress
addColumn('messages', 'chat_id', 'INTEGER')                     // command messages only
addColumn('orders', 'chat_id', 'INTEGER')                       // the chat the plan was made in
addColumn('orders', 'hotfix', 'INTEGER NOT NULL DEFAULT 0')     // 1 = tasks push straight to the project branch, no PR, review or QA

// The scheduler tick, the Home screen and the Inbox read these every few seconds; after columns, since some are new.
db.exec(`
CREATE INDEX IF NOT EXISTS tasks_project_status ON tasks (project_id, status);
CREATE INDEX IF NOT EXISTS runs_agent ON runs (agent_id, status, started_at);
CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, started_at);
CREATE INDEX IF NOT EXISTS runs_task ON runs (task_id);
CREATE INDEX IF NOT EXISTS inbox_project_status ON inbox (project_id, status);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id);
CREATE INDEX IF NOT EXISTS crew_messages_to ON crew_messages (to_agent_id, delivered);
`)

// Command history from before chats becomes one "Earlier chat" per floor.
for (const { project_id, floor, first, last } of db.prepare(`SELECT project_id, floor, MIN(created_at) first, MAX(created_at) last FROM messages
  WHERE channel = 'command' AND chat_id IS NULL GROUP BY project_id, floor`).all()) {
  const id = Number(db.prepare('INSERT INTO chats (project_id, floor, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(project_id, floor, 'Earlier chat', first, last).lastInsertRowid)
  db.prepare(`UPDATE messages SET chat_id = ? WHERE project_id = ? AND floor = ? AND channel = 'command' AND chat_id IS NULL`).run(id, project_id, floor)
  db.prepare('UPDATE orders SET chat_id = ? WHERE project_id = ? AND floor = ? AND chat_id IS NULL').run(id, project_id, floor)
}

// Transcripts of old runs are noise; merged work lives on GitHub.
db.prepare("DELETE FROM run_events WHERE created_at < datetime('now', '-14 days')").run()
// Terminal logs go with them; prompt files belong to runs, and no run survives a restart.
const sweep = (dir, maxAge = 0) => {
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    try { if (!maxAge || statSync(p).mtimeMs < Date.now() - maxAge) rmSync(p, { force: true }) } catch {}
  }
}
sweep(join(DATA_DIR, 'pty'), 14 * 86400000)
sweep(join(DATA_DIR, 'prompts'))

// Settings saves the whole form, so projects that saved once kept the old wide default; they follow the new one again.
const OLD_BASH = '^(npm|pnpm|yarn|npx|node|git (status|diff|log|show|add|commit|checkout|switch|branch|merge|stash|rev-parse|rm|mv|restore)|ls|cat|head|tail|wc|grep|rg|find|pwd|echo|cd|mkdir|sort|uniq|diff|sleep|wait|true|kill %\\d+|pytest|go test|cargo (test|build|check)|make)\\b'
db.prepare("UPDATE projects SET settings = json_remove(settings, '$.auto_allow_bash') WHERE json_valid(settings) AND json_extract(settings, '$.auto_allow_bash') = ?").run(OLD_BASH)

export const DEFAULT_SETTINGS = {
  protected_paths: ['.env*', '**/.env*', '**/*.pem', '**/*.key', '**/secrets/**', '.github/workflows/**', '**/migrations/**'],
  autonomy: 1,                 // only 1 (humans merge) is implemented in the MVP
  plan_approval_small: true,   // false = S-size plans auto-approve
  digest_hour: 8,              // local hour for the morning digest, null = off
  project_daily_token_budget: 20000000,
  project_daily_cost_budget: null,  // dollars per local day, null = no limit
  permission_timeout_min: 15,  // unanswered permission prompts are denied after this
  question_timeout_min: 30,    // crew_ask to the owner gives up after this
  github_issues: true,         // one GitHub issue per approved task, labelled as it moves
  auto_allow_bash: '^(npm (test|ci|run \\S+)\\b|npm (install|i)\\s*$|(pnpm|yarn) (test|run \\S+)\\b|(pnpm|yarn)( install)?\\s*$|node (--test\\b|(?!-)\\S+)|git (status|diff|log|show|add|commit|checkout|switch|branch|merge|stash|rev-parse|rm|mv|restore)|ls|cat|head|tail|wc|grep|rg|find|pwd|echo|cd|mkdir|sort|uniq|diff|sleep|wait|true|kill %\\d+|pytest|go test|cargo (test|build|check)|make)\\b',
}

// Columns stored as JSON text; parsed on read by row()/rows().
const JSON_COLS = ['proposal', 'settings', 'owned_paths', 'readonly_paths', 'permissions', 'plan', 'acceptance', 'depends_on', 'files', 'sub', 'pending_permission', 'tags']

function parse(r) {
  if (!r) return r
  for (const c of JSON_COLS) if (typeof r[c] === 'string') try { r[c] = JSON.parse(r[c]) } catch {}
  if (r.settings) r.settings = { ...DEFAULT_SETTINGS, ...r.settings }
  return r
}

export const all = (sql, ...p) => db.prepare(sql).all(...p).map(r => parse({ ...r }))
export const get = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r && parse({ ...r }) }
export const run = (sql, ...p) => db.prepare(sql).run(...p)

// Objects/arrays become JSON text so callers can pass plain values.
const val = v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v)

export function insert(table, obj) {
  const keys = Object.keys(obj)
  const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => val(obj[k])))
  return Number(r.lastInsertRowid)
}

export function update(table, id, obj) {
  const keys = Object.keys(obj)
  if (!keys.length) return
  if (table === 'tasks') obj.updated_at = now(), keys.push('updated_at')
  run(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(',')} WHERE id = ?`, ...keys.map(k => val(obj[k])), id)
}

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

export const getProject = id => get('SELECT * FROM projects WHERE id = ?', id)
export const getAgent = id => get('SELECT * FROM agents WHERE id = ?', id)
export const getTask = id => get('SELECT * FROM tasks WHERE id = ?', id)
export const getOrder = id => get('SELECT * FROM orders WHERE id = ?', id)
export const activeAgents = project_id => all('SELECT * FROM agents WHERE project_id = ? AND removed_at IS NULL ORDER BY id', project_id)

// Update a task and broadcast it. Use this instead of update('tasks') so the Board stays live.
export function setTask(id, fields) {
  update('tasks', id, fields)
  const t = getTask(id)
  emit('task', t.project_id, t)
  return t
}

export function setAgent(id, fields) {
  update('agents', id, fields)
  const a = getAgent(id)
  emit('agent', a.project_id, a)
  return a
}

export function setOrder(id, fields) {
  update('orders', id, fields)
  const o = getOrder(id)
  emit('order', o.project_id, o)
  return o
}

export function log(project_id, kind, text, extra = {}) {
  const id = insert('activity', { project_id, kind, text, ...extra })
  emit('activity', project_id, get('SELECT * FROM activity WHERE id = ?', id))
  return id
}

export function addMessage(project_id, role, text, order_id = null, extra = {}) {
  const id = insert('messages', { project_id, role, text, order_id, ...extra })
  if (extra.chat_id) run("UPDATE chats SET updated_at = datetime('now') WHERE id = ?", extra.chat_id)
  emit('message', project_id, get('SELECT * FROM messages WHERE id = ?', id))
  return id
}

// Everything that needs the human goes through here; notify.js pushes on the 'inbox' event with data.created = true.
export function addInbox(project_id, kind, title, extra = {}) {
  const id = insert('inbox', { project_id, kind, title, ...extra })
  emit('inbox', project_id, { ...get('SELECT * FROM inbox WHERE id = ?', id), created: true })
  return id
}

export function addRunEvent(run_id, project_id, seq, type, json) {
  const created_at = now()
  insert('run_events', { run_id, seq, type, json, created_at })
  emit('run_event', project_id, { run_id, seq, type, json, created_at })
}

export function resolveInbox(id) {
  update('inbox', id, { status: 'done', resolved_at: now() })
  const i = get('SELECT * FROM inbox WHERE id = ?', id)
  emit('inbox', i.project_id, i)
}
