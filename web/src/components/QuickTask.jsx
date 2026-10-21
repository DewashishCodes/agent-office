import { useState } from 'react'
import { api } from '../api.js'
import { Button, ErrorText, Sheet, useAction } from '../ui.jsx'

const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean)

// A one-task order straight to one agent, no plan round trip.
export default function QuickTask({ pid, agent, onClose }) {
  const [f, setF] = useState({ title: '', description: '', acceptance: '', files: '' })
  const [run, busy, error] = useAction()
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const submit = e => {
    e.preventDefault()
    run(async () => {
      await api(`/projects/${pid}/tasks`, {
        method: 'POST',
        body: { agent, title: f.title.trim(), description: f.description.trim(), acceptance: lines(f.acceptance), files: lines(f.files) },
      })
      onClose()
    })
  }
  return (
    <Sheet title={`Quick task for ${agent}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Title</span><input value={f.title} onChange={set('title')} required placeholder="Fix the typo on the login screen" /></label>
        <label className="field"><span>What to do</span><textarea rows="4" value={f.description} onChange={set('description')} /></label>
        <label className="field"><span>Acceptance criteria (one per line, optional)</span><textarea rows="3" value={f.acceptance} onChange={set('acceptance')} /></label>
        <label className="field"><span>Files it may touch (one glob per line, optional)</span><textarea rows="2" className="mono" value={f.files} onChange={set('files')} /></label>
        <p className="muted small">Skips the Orchestrator. Reviewer and QA still check the PR.</p>
        <div className="actions">
          <Button type="submit" variant="primary" disabled={busy || !f.title.trim()}>Start task</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
        <ErrorText error={error} />
      </form>
    </Sheet>
  )
}
