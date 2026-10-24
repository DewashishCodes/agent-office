import { Button, ErrorText, useAction } from '../ui.jsx'

const FILE_WRITERS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

// Agents lead with cd "<their worktree>" &&, which is noise to the owner.
const shown = cmd => String(cmd || '').replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '')

// Files a request would write: the target of a file tool, or redirect and tee targets of a shell command.
export function writtenFiles(req) {
  const input = req.input || {}
  if (FILE_WRITERS.includes(req.tool_name)) return [input.file_path || input.notebook_path].filter(Boolean)
  if (req.tool_name !== 'Bash') return []
  const cmd = shown(input.command)
  const out = [...cmd.matchAll(/(?:^|[^0-9&<=-])>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g), ...cmd.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
    .map(m => m[1].replace(/^["']|["']$/g, '')).filter(f => f !== '/dev/null' && !f.startsWith('&'))
  return [...new Set(out)]
}

// One permission card for the Inbox, Home's Needs you and the agent terminals. onAnswer(allow, remember) answers it.
export default function Permission({ req, who, onAnswer }) {
  const [run, busy, error] = useAction()
  const bash = req.tool_name === 'Bash'
  const files = writtenFiles(req)
  const answer = (allow, remember) => run(() => onAnswer(allow, remember))
  return (
    <div className="permission">
      <p className="small">{who ? <b>{who} </b> : null}{bash ? 'asks to run' : `asks to use ${req.tool_name || 'a tool'}`}</p>
      <pre className="code">{bash ? shown(req.input?.command) : req.summary || req.input?.file_path || req.input?.path || req.tool_name}</pre>
      {files.length > 0 && <p className="small">Writes <span className="mono">{files.join(', ')}</span></p>}
      <details className="small">
        <summary>Details</summary>
        <pre className="code">{JSON.stringify(req.input, null, 2)}</pre>
      </details>
      <div className="actions">
        <Button small variant="primary" disabled={busy} onClick={() => answer(true)}>Allow</Button>
        {bash && <Button small disabled={busy} onClick={() => answer(true, true)}>Allow, don't ask again</Button>}
        <Button small disabled={busy} onClick={() => answer(false)}>Deny</Button>
      </div>
      <ErrorText error={error} />
    </div>
  )
}
