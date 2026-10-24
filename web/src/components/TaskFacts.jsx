import { useState } from 'react'
import { useData } from '../api.js'
import { Button, ErrorText, Sheet, tokens } from '../ui.jsx'

const CHECKS = { pass: 'CI passed', fail: 'CI failing', pending: 'CI running', none: 'No CI' }

// What the owner needs before a merge: CI, the price and the diff. t is a task from GET /api/tasks/:id (with runs).
export default function TaskFacts({ t }) {
  const [diff, setDiff] = useState(false)
  const cost = (t.runs || []).reduce((s, r) => s + (r.cost_usd || 0), 0)
  const tok = (t.runs || []).reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0)
  return (
    <div className="row wrap small task-facts">
      {t.checks && <span className={`badge s-ci-${t.checks}`}>{CHECKS[t.checks] || t.checks}</span>}
      {t.conflict === 1 && <span className="badge s-ci-fail">Conflicts</span>}
      {t.conflict === 2 && <span className="badge s-ci-pending">Resolving conflicts</span>}
      <span className="muted">${cost.toFixed(2)}, {tokens(tok)} tok</span>
      {t.pr_number && <Button small variant="ghost" onClick={() => setDiff(true)}>View diff</Button>}
      {diff && <DiffSheet t={t} onClose={() => setDiff(false)} />}
    </div>
  )
}

function DiffSheet({ t, onClose }) {
  const [d, , error] = useData(`/tasks/${t.id}/diff`)
  return (
    <Sheet title={`PR #${t.pr_number} diff`} onClose={onClose}>
      <ErrorText error={error} />
      {!d && !error && <p className="muted">Loading</p>}
      {d && (d.diff ? <Diff text={d.diff} /> : <p className="muted">No changes.</p>)}
    </Sheet>
  )
}

const lineClass = l => l.startsWith('diff --git') ? 'd-file' : l.startsWith('@@') ? 'd-hunk'
  : l.startsWith('+++') || l.startsWith('---') ? 'd-meta' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : ''

export function Diff({ text }) {
  return <pre className="diff">{text.split('\n').map((l, i) => <span key={i} className={lineClass(l)}>{l || ' '}</span>)}</pre>
}

// The task behind an inbox card, kept fresh by task and run events.
export function useTask(id, pid) {
  return useData(id && `/tasks/${id}`, ev => ev.project_id === pid && ((ev.type === 'task' && ev.data.id === id) || (ev.type === 'run' && ev.data.task_id === id)))
}
