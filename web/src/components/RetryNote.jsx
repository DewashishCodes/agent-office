import { useState } from 'react'
import { Button, ErrorText, useAction } from '../ui.jsx'

// "Retry with my note": the note is added to the task's notes, so the next attempt is steered by the owner.
export default function RetryNote({ onRetry }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [run, busy, error] = useAction()
  if (!open) return <Button onClick={() => setOpen(true)}>Retry with my note</Button>
  return (
    <form className="stack retry-note" onSubmit={e => { e.preventDefault(); run(async () => { await onRetry(note.trim()); setOpen(false); setNote('') }) }}>
      <label className="field"><span>What should the agent do differently</span>
        <textarea rows="3" value={note} onChange={e => setNote(e.target.value)} required autoFocus
          placeholder="For example: the test needs the dev server running, start it with npm run dev first" />
      </label>
      <div className="actions">
        <Button type="submit" variant="primary" disabled={busy || !note.trim()}>Retry with this note</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <ErrorText error={error} />
    </form>
  )
}
