import { posix, win32, relative, isAbsolute, resolve } from 'node:path'

// Pure helpers. No db/runner/github imports so tests run without them.

const FENCE = /```json[^\S\n]*\n([\s\S]*?)```/g

const jsonBlocks = text => [...String(text ?? '').matchAll(FENCE)].map(m => {
  try { return { raw: m[0], value: JSON.parse(m[1]) } } catch { return { raw: m[0], value: undefined } }
})

// Plan is the last ```json block with a "tasks" array; the rest is the chat text.
export function parseReply(text) {
  text = String(text ?? '')
  const block = jsonBlocks(text).findLast(b => Array.isArray(b.value?.tasks))
  if (!block) return { text: text.trim(), plan: null }
  return { text: text.replace(block.raw, '').trim(), plan: block.value }
}

// Last ```json object in a Reviewer/QA reply, or null.
export function parseVerdict(text) {
  const b = jsonBlocks(text).findLast(b => b.value && typeof b.value === 'object' && !Array.isArray(b.value))
  return b?.value ?? null
}

const norm = p => String(p).replaceAll('\\', '/').replace(/^\.\//, '')

// Node globs skip dot segments under *, so also try with leading dots stripped (web/.eslintrc vs web/**).
const undot = p => p.replace(/(^|\/)\./g, '$1')
const match = (file, glob) => {
  const f = norm(file), g = norm(glob)
  return posix.matchesGlob(f, g) || posix.matchesGlob(undot(f), g)
}

// A task file (often a glob itself) is covered when it matches an owned glob or sits under an owned dir/**.
const covered = (file, owned) => owned.some(o => {
  const f = norm(file), g = norm(o)
  return match(f, g) || (g.endsWith('/**') && f.startsWith(g.slice(0, -2)))
})

export function matchAgent(agents, task) {
  const files = task.files || []
  // Agents with no owned paths (orchestrator, reviewer, qa) never take tasks.
  const ok = agents.filter(a => !a.removed_at && a.status !== 'paused' && a.owned_paths?.length && files.every(f => covered(f, a.owned_paths)))
  const name = task.plan_agent || task.agent
  return (name && ok.find(a => a.name === name)) || ok.find(a => a.role === task.role) || ok[0] || null
}

export function readyTasks(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  return tasks.filter(t => t.status === 'planned' && (t.depends_on || []).every(id => byId.get(id)?.status === 'done'))
}

// First dependency loop among plan tasks ({key, depends_on: keys}) as a key path, or null. A loop never becomes ready.
export function findCycle(tasks) {
  const deps = new Map(tasks.map(t => [String(t.key), (t.depends_on || []).map(String)]))
  const state = new Map(), path = []
  const visit = k => {
    if (state.get(k) === 'done' || !deps.has(k)) return null
    if (state.get(k) === 'open') return [...path.slice(path.indexOf(k)), k]
    state.set(k, 'open'); path.push(k)
    for (const d of deps.get(k)) { const c = visit(d); if (c) return c }
    state.set(k, 'done'); path.pop()
    return null
  }
  for (const k of deps.keys()) { const c = visit(k); if (c) return c }
  return null
}

export const isAllowed = (file, owned = [], protectedPaths = []) =>
  !protectedPaths.some(p => match(file, p)) && owned.some(o => match(file, o))

// Path relative to cwd with forward slashes, or null when it points outside cwd.
// A drive-letter cwd is a Windows path on any host, so the same rules hold in tests on Linux and macOS.
const inside = (cwd, p) => {
  const path = /^[A-Za-z]:/.test(String(cwd)) ? win32 : { relative, resolve, isAbsolute }
  const r = path.relative(cwd, path.resolve(cwd, String(p))).replaceAll('\\', '/')
  return r.startsWith('..') || path.isAbsolute(r) ? null : r
}

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']

// Decides a can_use_tool prompt: 'allow' | 'deny' | 'ask' (the owner decides). Deny rules in the CLI run before this.
export function permissionPolicy(settings, agent, tool, input = {}, cwd) {
  if (agent?.permissions?.autonomous) return 'allow'
  if (tool.startsWith('mcp__crew__')) return 'allow'
  if (['WebSearch', 'WebFetch'].includes(tool)) return agent?.permissions?.web ? 'allow' : 'ask'
  if (FILE_TOOLS.includes(tool)) {
    const p = input.file_path || input.notebook_path || input.path
    if (!p) return 'allow'
    const r = inside(cwd, p)
    // Read-only roots outside the worktree, e.g. the shared vault's files.
    if (r === null && ['Read', 'Glob', 'Grep', 'LS'].includes(tool) && (settings.read_roots || []).some(root => inside(root, p) !== null)) return 'allow'
    if (r === null) return 'ask'
    if (r && (settings.protected_paths || []).some(g => match(r, g))) return 'deny'
    return 'allow'
  }
  if (tool === 'Bash') {
    const parts = bashParts(input.command, { cwd })
    if (!parts) return 'ask'
    const ok = new RegExp(settings.auto_allow_bash)
    return parts.every(s => ok.test(s) || localCurl(s)) ? 'allow' : 'ask'
  }
  return 'ask'
}

// A Bash command as its simple parts, or null when it can hide another command (substitutions) or reach outside the
// worktree (find -exec/-delete, redirects or path arguments out of it). Quoted strings and heredoc bodies are data: they
// keep their words but lose separators.
function bashParts(command, { noRedirects = false, cwd } = {}) {
  const cmd = String(command || '').trim()
  // Substitutions can hide any command inside an allowed one. Quoted heredocs ('EOF') and single quotes never expand.
  const literal = cmd.replace(/<<-?\s*(['"])(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(\n|$)/g, '<<\n').replace(/'[^']*'/g, "''")
  if (!cmd || /\$\(|`|<\(/.test(literal)) return null
  const bare = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, '<<\n')
    .replace(/"(\\.|[^"\\])*"|'[^']*'/g, q => q.replace(/[;|&\n<>()]/g, ' '))
  if (/\s-(exec|execdir|delete|ok)\b/.test(bare) || /(^|[^0-9&])>+\s*(?!\/dev\/null|\/tmp\/)(\/|~|[A-Za-z]:|\.\.)/.test(bare)) return null
  // Read-only callers: any write redirect (other than to /dev/null or 2>&1) is a write.
  if (noRedirects && /(^|[^0-9&])>+(?!\s*\/dev\/null|&)/.test(bare)) return null
  // Split on && || ; | newlines and a lone & (not 2>&1); drop subshell parens and VAR=value prefixes.
  const parts = bare.split(/&&|\|\||;|\||\n|(?<![>&])&(?![>&])/)
    .map(s => s.trim().replace(/^\(+\s*/, '').replace(/\s*\)+$/, '').replace(/^(\w+=\S*\s+)+/, '').trim()).filter(Boolean)
  return parts.some(p => outsideArg(p, cwd)) ? null : parts
}

// An allowed command (cat, head) is only as safe as the files it is pointed at: an argument that is absolute, starts
// with ~ or climbs with .. must stay inside cwd. A quoted string with spaces (a commit message) counts only when it
// starts like a path.
function outsideArg(part, cwd) {
  return (part.match(/"(\\.|[^"\\])*"|'[^']*'|\S+/g) || []).some(tok => {
    const t = tok.replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/^\d*[<>]+&?/, '').replace(/^-[\w-]*=/, '')
    const message = /^["']/.test(tok) && /\s/.test(t)
    const pathy = /^([/\\~]|[A-Za-z]:[/\\])/.test(t) || (!message && /(^|[/\\])\.\.([/\\]|$)/.test(t))
    if (!pathy || /^\/dev\/null$|^\/tmp\//.test(t)) return false
    return t.startsWith('~') || !cwd || inside(cwd, t) === null
  })
}

// Commands Support may run without asking: they look, they never change anything.
const LOOK = /^(git (status|diff|log|show|rev-parse|ls-files|blame|grep|describe)|git (branch|tag|remote)(\s+(-[avr]+|--list|-vv))*\s*$|ls|dir|cat|type|head|tail|wc|grep|rg|find|pwd|echo|which|where|date|whoami|uname|df|du|ps|tasklist|netstat|lsof|node (-v|--version)|python3? (-V|--version)|npm (-v|--version|ls|list|outdated|view|test|run (test|lint|check|typecheck|build))|pnpm (test|lint|ls)|yarn (test|lint)|npx (tsc --noEmit|eslint|vitest run|jest)|pytest|go (test|vet)|cargo (test|check))\b/
const SQL_CLI = /^(sqlite3|psql|mysql|mariadb)\b/
const SQL_WRITE = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|reindex|grant|revoke|copy|merge|upsert|call|do)\b|\bpragma\s+\w+\s*=|\.(read|import|output|once|save|restore|backup|shell|system|load)\b/i
const SQL_READ = /^\s*(select|with|explain|show|describe|desc|pragma|\.tables|\.schema|\.indexes|\\d)/i

// A database CLI call whose SQL only reads. No SQL in quotes (an interactive shell, a script file) is not a read.
export function readOnlySql(part) {
  if (!SQL_CLI.test(part)) return false
  const sql = [...part.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)].map(m => m[1] ?? m[2]).filter(q => /\s/.test(q) || /^\./.test(q))
  if (!sql.length || /(^|\s)(-f|--file|<)(\s|$)/.test(part)) return false
  return sql.every(q => !SQL_WRITE.test(q) && q.split(';').map(x => x.trim()).filter(Boolean).every(x => SQL_READ.test(x)))
}

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
// Support: looking around and read-only queries run; anything that changes state asks the owner; code is never edited.
export function supportPolicy(settings, tool, input = {}, cwd) {
  if (tool.startsWith('mcp__crew__') || tool === 'TodoWrite') return 'allow'
  if (WRITE_TOOLS.includes(tool)) return 'deny'
  if (['Read', 'Glob', 'Grep', 'LS'].includes(tool)) {
    const p = input.file_path || input.path
    if (!p) return 'allow'
    const r = inside(cwd, p)
    if (r && (settings.protected_paths || []).some(g => match(r, g))) return 'deny'
    return r === null ? 'ask' : 'allow'
  }
  if (tool === 'Bash') {
    const parts = bashParts(input.command, { noRedirects: true, cwd })
    if (!parts) return 'ask'
    return parts.every(s => (LOOK.test(s) && !/^(find|rg|grep)\b.*\s-(delete|exec)/.test(s)) || localCurl(s) || readOnlySql(s)) ? 'allow' : 'ask'
  }
  return 'ask'
}

const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?([/?#]\S*)?$/
const CURL_ARG = /^(-[wHXdmo]|--(write-out|header|request|data|data-raw|max-time|connect-timeout|output))$/

// curl against this machine only (agents check their own dev server); uploads and config files still ask.
function localCurl(part) {
  const toks = (part.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^(["'])(.*)\1$/, '$2'))
  if (toks[0] !== 'curl') return false
  let local = false
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]
    if (CURL_ARG.test(t)) {
      const arg = toks[++i] ?? ''
      if (/^(-o|--output)$/.test(t) && arg !== '/dev/null' && (/^([/~]|[A-Za-z]:)/.test(arg) || arg.includes('..'))) return false
    } else if (t.startsWith('-')) {
      if (/^(-T|--upload-file|-F|--form|-K|--config)$/.test(t)) return false
    } else if (LOCAL_URL.test(t)) local = true
    else return false
  }
  return local
}

// Glob prefix before the first wildcard segment: "web/src/**" -> "web/src".
const stem = g => {
  const segs = norm(g).split('/'), i = segs.findIndex(x => /[*?[{]/.test(x))
  return (i < 0 ? segs : segs.slice(0, i)).filter(Boolean).join('/')
}

// Two file lists collide when one stem is a prefix of the other (an empty stem covers everything).
export function overlaps(a = [], b = []) {
  const under = (x, y) => !y || x === y || x.startsWith(y + '/')
  return a.some(f => b.some(g => { const x = stem(f), y = stem(g); return under(x, y) || under(y, x) }))
}

// When one task depends (directly or not) on every other, its branch already merged and passed review and QA with
// all of them, so there is nothing left to fit together. Returns task ids in merge order (dependencies first), or null.
export function chainOrder(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const reach = id => {
    const seen = new Set(), stack = [...(byId.get(id).depends_on || [])]
    while (stack.length) {
      const d = stack.pop()
      if (seen.has(d) || !byId.has(d)) continue
      seen.add(d)
      stack.push(...(byId.get(d).depends_on || []))
    }
    return seen.size
  }
  const size = new Map(tasks.map(t => [t.id, reach(t.id)]))
  if (![...size.values()].includes(tasks.length - 1)) return null
  return [...tasks].sort((a, b) => size.get(a.id) - size.get(b.id) || a.id - b.id).map(t => t.id)
}

// Office proposal from the Onboarding agent: the last ```json block with an "agents" array. Pure: the caller passes the
// floor list and templates. Unknown entries are dropped with a note; every floor gets its lead and reviewer (Tech also QA),
// marked locked so the owner cannot untick them.
const MODELS = ['opus', 'sonnet', 'haiku']
const REQUIRED = f => f === 'tech' ? ['orchestrator', 'reviewer', 'qa'] : [`${f}-lead`, `${f}-reviewer`]

export function parseProposal(text, { floors, templates }) {
  const block = jsonBlocks(text).findLast(b => Array.isArray(b.value?.agents))
  if (!block) return { text: String(text ?? '').trim(), proposal: null }
  const v = block.value, notes = []
  const keyOf = t => t.key || t.role
  const floorKeys = new Set(floors.map(f => f.key))
  const open = new Set(['tech', ...(Array.isArray(v.floors) ? v.floors : []).filter(f => floorKeys.has(f))])
  const str = (x, max = 4000) => typeof x === 'string' ? x.trim().slice(0, max) : ''
  const agents = []
  for (const a of v.agents) {
    if (!a || typeof a !== 'object') continue
    if (a.template != null) {
      const t = templates.find(t => keyOf(t) === a.template)
      if (!t || t.role === 'support' || t.role === 'onboarding') { notes.push(`Unknown template "${a.template}" left out.`); continue }
      agents.push({ template: keyOf(t), name: str(a.name, 80) || t.name, floor: t.floor || 'tech', role: t.role, specialty: t.specialty })
      continue
    }
    const name = str(a.name, 80), floor = floorKeys.has(a.floor) ? a.floor : 'tech'
    const owned = Array.isArray(a.owned_paths) ? a.owned_paths.filter(p => typeof p === 'string' && p.trim() && !p.includes('..')).map(p => p.trim()) : []
    if (!name || !owned.length) { notes.push(`Custom agent "${name || '?'}" needs a name and owned paths; left out.`); continue }
    agents.push({
      name, floor, role: str(a.role, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'custom', specialty: str(a.specialty, 200),
      instructions: str(a.instructions), owned_paths: owned, readonly_paths: ['**'], model: MODELS.includes(a.model) ? a.model : 'sonnet',
    })
  }
  for (const a of agents) open.add(a.floor)
  for (const f of open) for (const k of REQUIRED(f)) {
    const t = templates.find(t => keyOf(t) === k)
    const have = agents.find(a => a.template === k)
    if (have) have.locked = true
    else if (t) agents.unshift({ template: k, name: t.name, floor: f, role: t.role, specialty: t.specialty, locked: true })
  }
  // Names address agents (crew_post, plans), so they must be unique.
  const seen = new Map()
  for (const a of agents) {
    const n = (seen.get(a.name) || 0) + 1
    seen.set(a.name, n)
    if (n > 1) a.name = `${a.name} ${n}`
  }
  const order = floors.map(f => f.key)
  return {
    text: String(text).replace(block.raw, '').trim(),
    proposal: {
      brief: str(v.brief, 20000), floors: order.filter(f => open.has(f)),
      agents: agents.sort((a, b) => order.indexOf(a.floor) - order.indexOf(b.floor)),
      first_order: str(v.first_order) || null, notes,
    },
  }
}

// Failed logins per IP: after max misses the IP waits out the window. Memory only, so a restart clears it.
export function loginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const misses = new Map()
  const current = (ip, now) => {
    const m = misses.get(ip)
    if (m && now - m.at > windowMs) misses.delete(ip)
    return misses.get(ip)
  }
  return {
    blocked: (ip, now = Date.now()) => (current(ip, now)?.n || 0) >= max,
    miss(ip, now = Date.now()) {
      const m = current(ip, now)
      misses.set(ip, { n: (m?.n || 0) + 1, at: m?.at ?? now })
      if (misses.size > 10000) for (const k of misses.keys()) current(k, now)
    },
    clear: ip => misses.delete(ip),
  }
}

// Tools whose second word is the real command (git fetch, npm audit); remembering only the first would allow them all.
const SUBCOMMANDS = ['git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'uv', 'dotnet', 'composer', 'bundle']
// Wrappers and interpreters run any command they are given, so "don't ask again" for them would allow everything.
const OPEN_ENDED = /^(bash|sh|zsh|fish|cmd|powershell|pwsh|env|sudo|su|xargs|eval|exec|nohup|time|timeout|watch|node|python3?|py|ruby|perl|php|deno|npx|bunx|pnpx|curl|wget|ssh|scp|rm|chmod|chown|dd|git (push|reset|clean|config|filter-branch)|gh)$/

// "Allow, don't ask again": the command's first word (or first two for git, npm...) as a pattern for auto_allow_bash.
// Returns { prefix, pattern } or { error }. A1's path check still applies to anything the pattern allows.
export function rememberPattern(command) {
  // Agents lead with cd "<worktree>" &&, an absolute path bashParts would refuse without the run's cwd.
  const parts = bashParts(String(command || '').replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&/, ''))
  if (!parts) return { error: 'This command can hide another one or reach outside the worktree; allow it once instead.' }
  const rest = parts.filter(p => !/^cd(\s|$)/.test(p))
  if (rest.length !== 1) return { error: 'Only a single command can be remembered; allow it once instead.' }
  const words = rest[0].split(/\s+/)
  const prefix = (SUBCOMMANDS.includes(words[0]) && words[1] && !words[1].startsWith('-') ? words.slice(0, 2) : words.slice(0, 1)).join(' ')
  if (!/^[\w./-]+( [\w.:-]+)?$/.test(prefix)) return { error: 'That command cannot be remembered; allow it once instead.' }
  if (OPEN_ENDED.test(prefix)) return { error: `${prefix} can run anything; allow it once instead.` }
  return { prefix, pattern: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b` }
}

// Fixed guesses until a project has finished tasks of a size; per task, review and QA runs included.
const GUESS = { S: { tokens: 400000, cost: 0.5 }, M: { tokens: 1200000, cost: 1.5 }, L: { tokens: 3000000, cost: 4 } }
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// Plan estimates per size from the project's own done tasks ({size, tokens, cost} each): the median, or a guess.
export function estimates(rows = []) {
  return Object.fromEntries(Object.entries(GUESS).map(([size, guess]) => {
    const done = rows.filter(r => r.size === size)
    return [size, done.length ? { tokens: median(done.map(r => r.tokens)), cost: median(done.map(r => r.cost)), n: done.length } : { ...guess, n: 0 }]
  }))
}
