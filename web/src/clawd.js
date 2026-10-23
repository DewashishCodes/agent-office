// Which Clawd animation (web/public/clawd/<set>/loop.gif) shows what an agent is doing.
// Clawd pixel art by CodeChrisB/MyClawd (Clawd is Anthropic's mascot).

const IDLE = ['idle-coffee', 'idle-book', 'idle-look', 'idle-doze', 'idle']

// ev is null until the run's first tool call.
function forTool(ev) {
  if (!ev) return null
  const [tool, ...rest] = ev.split(' ')
  const arg = rest.join(' ')
  if (tool === 'Bash') {
    if (/\bgit push\b/.test(arg)) return 'git-push'
    if (/\bgit commit\b/.test(arg)) return 'git-commit'
    if (/\bgh pr\b/.test(arg)) return 'git-pr'
    if (/\b(test|tests|vitest|jest|pytest|playwright)\b/.test(arg)) return 'testing'
    return 'bash'
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'writing'
  if (tool === 'Read') return 'reading'
  if (['Grep', 'Glob', 'LS'].includes(tool)) return 'search'
  if (['WebFetch', 'WebSearch'].includes(tool)) return 'web-fetch'
  if (tool === 'TodoWrite') return 'todo-list'
  if (['Task', 'Agent'].includes(tool)) return 'agents'
  if (tool === 'crew_post') return 'new-mail'
  if (tool === 'crew_ask') return 'ask'
  if (tool === 'crew_read') return 'read-note'
  return null
}

// a: agent row, r: its newest run (wall shape). Returns a set name.
export function clawdFor(a, r) {
  if (r?.status === 'running') {
    if (r.pending_permission?.length) return 'permission'
    if (r.state === 'handed_off') return 'handoff'
    if (r.state === 'paused') return 'interrupt'
    if (r.state === 'waiting') return 'teammate-idle'
    return forTool(r.last_event) || (r.kind === 'review' ? 'code-review' : r.kind === 'qa' ? 'testing' : 'thinking')
  }
  if (a.status === 'paused') return 'idle-doze'
  // A just-finished run gets its moment, then the agent idles.
  const ended = r?.ended_at && (Date.now() - new Date(r.ended_at.replace(' ', 'T') + 'Z')) < 90000
  if (ended && r.status === 'ok') return 'celebrate'
  if (ended && r.status === 'error') return 'crash'
  return IDLE[a.id % IDLE.length]
}

export const clawdUrl = set => `/clawd/${set}/loop.gif`
