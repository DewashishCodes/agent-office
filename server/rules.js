import { posix, relative, isAbsolute, resolve } from 'node:path'

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
const inside = (cwd, p) => {
  const r = relative(cwd, resolve(cwd, String(p))).replaceAll('\\', '/')
  return r.startsWith('..') || isAbsolute(r) ? null : r
}

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']

// Decides a can_use_tool prompt: 'allow' | 'deny' | 'ask' (the owner decides). Deny rules in the CLI run before this.
export function permissionPolicy(settings, agent, tool, input = {}, cwd) {
  if (agent?.permissions?.autonomous) return 'allow'
  if (tool.startsWith('mcp__crew__')) return 'allow'
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
    const cmd = String(input.command || '').trim()
    // Substitutions can hide any command inside an allowed one. Quoted heredocs ('EOF') and single quotes never expand.
    const literal = cmd.replace(/<<-?\s*(['"])(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(\n|$)/g, '<<\n').replace(/'[^']*'/g, "''")
    if (!cmd || /\$\(|`|<\(/.test(literal)) return 'ask'
    // Heredoc bodies are data; quoted strings (commit messages, curl headers) keep their words but lose separators.
    const bare = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, '<<\n')
      .replace(/"(\\.|[^"\\])*"|'[^']*'/g, q => q.replace(/[;|&\n<>()]/g, ' '))
    // find -exec/-delete and redirects out of the worktree turn a harmless prefix into anything.
    if (/\s-(exec|execdir|delete|ok)\b/.test(bare) || /(^|[^0-9&])>+\s*(?!\/dev\/null|\/tmp\/)(\/|~|[A-Za-z]:|\.\.)/.test(bare)) return 'ask'
    const ok = new RegExp(settings.auto_allow_bash)
    // Split on && || ; | newlines and a lone & (not 2>&1); drop subshell parens and VAR=value prefixes.
    const parts = bare.split(/&&|\|\||;|\||\n|(?<![>&])&(?![>&])/)
      .map(s => s.trim().replace(/^\(+\s*/, '').replace(/\s*\)+$/, '').replace(/^(\w+=\S*\s+)+/, '').trim()).filter(Boolean)
    return parts.every(s => ok.test(s) || localCurl(s)) ? 'allow' : 'ask'
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
