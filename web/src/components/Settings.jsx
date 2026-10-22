import { useState } from 'react'
import { api } from '../api.js'
import { Button, ErrorText, Sheet, useAction } from '../ui.jsx'

const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean)

// General project settings (PATCH /api/projects/:id). Field names follow DEFAULT_SETTINGS in server/db.js.
export default function Settings({ project, onClose, reload }) {
  const s = project.settings || {}
  const [f, setF] = useState({
    name: project.name,
    budget: String(s.project_daily_token_budget ?? ''),
    perm: String(s.permission_timeout_min ?? 15),
    question: String(s.question_timeout_min ?? 30),
    digest: s.digest_hour == null ? '' : String(s.digest_hour),
    approveSmall: s.plan_approval_small !== false,
    protectedPaths: (s.protected_paths || []).join('\n'),
    bash: s.auto_allow_bash || '',
  })
  const [run, busy, error] = useAction()
  const [saved, setSaved] = useState(false)
  const set = k => e => { setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })); setSaved(false) }
  const save = e => {
    e.preventDefault()
    run(async () => {
      await api(`/projects/${project.id}`, {
        method: 'PATCH',
        body: {
          name: f.name.trim(),
          settings: {
            project_daily_token_budget: Number(f.budget), permission_timeout_min: Number(f.perm), question_timeout_min: Number(f.question),
            digest_hour: f.digest === '' ? null : Number(f.digest), plan_approval_small: f.approveSmall,
            protected_paths: lines(f.protectedPaths), auto_allow_bash: f.bash,
          },
        },
      })
      setSaved(true)
      reload?.()
    })
  }
  return (
    <Sheet title="Project settings" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <p className="muted small">{project.repo}</p>
        <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} required /></label>
        <div className="grid2">
          <label className="field"><span>Daily token budget for the project</span><input type="number" min="0" step="1000000" value={f.budget} onChange={set('budget')} required /></label>
          <label className="field"><span>Morning digest hour (0 to 23, empty = off)</span><input type="number" min="0" max="23" value={f.digest} onChange={set('digest')} /></label>
          <label className="field"><span>Deny unanswered permission prompts after (minutes)</span><input type="number" min="1" value={f.perm} onChange={set('perm')} required /></label>
          <label className="field"><span>Agents stop waiting for your answer after (minutes)</span><input type="number" min="1" value={f.question} onChange={set('question')} required /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.approveSmall} onChange={set('approveSmall')} /> Small (S) plans also need my approval</label>
        <label className="field"><span>Protected paths: no agent may read or change these (one glob per line)</span>
          <textarea rows="5" className="mono" value={f.protectedPaths} onChange={set('protectedPaths')} />
        </label>
        <details>
          <summary className="small">Advanced: commands agents may run without asking</summary>
          <label className="field"><span>Regular expression each part of a Bash command must match</span>
            <textarea rows="4" className="mono" value={f.bash} onChange={set('bash')} spellCheck="false" />
          </label>
        </details>
        <div className="actions">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving' : 'Save settings'}</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {saved && <span className="ok small" role="status">Saved</span>}
        </div>
        <ErrorText error={error} />
      </form>
    </Sheet>
  )
}
