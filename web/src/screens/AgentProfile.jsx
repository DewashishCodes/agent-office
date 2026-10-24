import { useEffect, useState } from 'react'
import { api, useData } from '../api.js'
import { Badge, Button, Empty, ErrorText, StatusDot, ago, initials, taskStatus, tokens, useAction } from '../ui.jsx'
import { RunItem } from './Board.jsx'
import Terminal from '../components/Terminal.jsx'
import ModelEffort from '../components/ModelEffort.jsx'

const PERMS = [['open_pr', 'Open PRs'], ['comment', 'Comment on PRs'], ['run_tests', 'Run tests'], ['merge', 'Merge'], ['autonomous', 'Autonomous (never asks before commands)']]
const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean)

function toForm(a) {
  return {
    name: a.name, role: a.role, specialty: a.specialty, instructions: a.instructions,
    max_parallel: a.max_parallel, daily_token_budget: a.daily_token_budget,
    owned_paths: (a.owned_paths || []).join('\n'), readonly_paths: (a.readonly_paths || []).join('\n'),
    permissions: { ...a.permissions },
  }
}

export default function AgentProfile({ pid, id }) {
  const [a, reload, error] = useData(`/agents/${id}`, ev => ev.project_id === pid && (
    (ev.type === 'agent' && ev.data.id === id) ||
    (ev.type === 'task' && ev.data.agent_id === id) ||
    (ev.type === 'run' && ev.data.agent_id === id && ev.data.status !== 'running')))
  // The form is seeded once so live refetches never wipe unsaved edits.
  const [form, setForm] = useState(null)
  useEffect(() => { if (a && !form) setForm(toForm(a)) }, [a, form])
  const [saved, setSaved] = useState(false)
  const [note, setNote] = useState('')
  const [run, busy, saveError] = useAction()
  const [runNote, noteBusy, noteError] = useAction()

  if (error) return <section className="page"><a href="#/wall">Back to agents</a><ErrorText error={error} /></section>
  if (!a || !form) return <section className="page muted">Loading</section>

  const lastRun = a.runs?.[0]
  const current = a.tasks?.find(t => t.status === 'in_progress')
  const doneCount = a.tasks?.filter(t => t.status === 'done').length || 0
  const cost = (a.runs || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0)
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setSaved(false) }
  const save = e => {
    e.preventDefault()
    // Role is fixed after creation; plans address agents by name.
    const { role, ...fields } = form
    run(async () => {
      await api(`/agents/${id}`, {
        method: 'PATCH',
        body: {
          ...fields,
          max_parallel: Number(form.max_parallel), daily_token_budget: Number(form.daily_token_budget),
          owned_paths: lines(form.owned_paths), readonly_paths: lines(form.readonly_paths),
        },
      })
      setSaved(true)
      reload()
    })
  }
  const addNote = e => {
    e.preventDefault()
    runNote(async () => { await api(`/agents/${id}/notes`, { method: 'POST', body: { text: note.trim() } }); setNote(''); reload() })
  }
  const f = (k, label, props = {}) => (
    <label className="field"><span>{label}</span>
      <input value={form[k] ?? ''} onChange={e => set(k, e.target.value)} {...props} />
    </label>
  )

  return (
    <section className="page stack">
      <a href="#/wall" className="back">Back to agents</a>
      <header className="row">
        <span className="avatar big" aria-hidden="true">{initials(a.name)}</span>
        <div className="grow">
          <h1>{a.name} <StatusDot status={a.status} /></h1>
          <p className="muted small">{a.role}{a.specialty ? `, ${a.specialty}` : ''}</p>
          <p className="muted small">{doneCount} of the last {a.tasks?.length || 0} tasks done, ${cost.toFixed(2)} over the last {a.runs?.length || 0} runs, budget {tokens(a.daily_token_budget)} tokens a day</p>
        </div>
      </header>
      <ModelEffort a={a} onSaved={reload} />

      <section className="card stack">
        <div className="row wrap">
          <h2 className="grow">Now</h2>
          {lastRun && <Badge status={lastRun.status} />}
        </div>
        <p className="small">{current ? <>On: {current.title}</> : <span className="muted">{a.status === 'paused' ? 'Paused' : 'No current task'}</span>}</p>
        <Terminal run={lastRun} />
        {lastRun?.status === 'running' && <a className="small" href="#/wall">Pause, message or take over on the wall</a>}
      </section>

      <section className="card stack">
        <h2>Notes</h2>
        <p className="muted small">Notes are added to this agent's prompt on every task.</p>
        {a.notes?.length ? (
          <ul className="feed">{a.notes.map(n => <li key={n.id}><span className="pre">{n.text}</span> <span className="muted small">{ago(n.created_at)}</span></li>)}</ul>
        ) : <Empty>No notes yet</Empty>}
        <form className="row" onSubmit={addNote}>
          <label className="field grow"><span>New note</span>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Always run npm test before committing" />
          </label>
          <Button type="submit" disabled={noteBusy || !note.trim()}>Add note</Button>
        </form>
        <ErrorText error={noteError} />
      </section>

      <section className="card stack">
        <h2>Recent tasks</h2>
        {a.tasks?.length ? (
          <ul className="feed">
            {a.tasks.map(t => (
              <li key={t.id} className="row"><span className="mono small">#{t.id}</span><span className="grow">{t.title}</span><Badge status={taskStatus(t)} /></li>
            ))}
          </ul>
        ) : <Empty>No tasks yet</Empty>}
      </section>

      <section className="card stack">
        <h2>Conversation</h2>
        <p className="muted small">What this agent said at the end of each recent run. Read only.</p>
        {a.runs?.length ? <ul className="list">{a.runs.map(r => <RunItem key={r.id} r={r} />)}</ul> : <Empty>No runs yet</Empty>}
      </section>

      <details className="card settings">
        <summary><h2>Settings</h2><span className="muted small">budget, paths, permissions</span></summary>
        <form className="stack" onSubmit={save}>
          <div className="grid2">
            {f('name', 'Name', { required: true })}
            {f('role', 'Role (set at creation)', { readOnly: true })}
          </div>
          {f('specialty', 'Specialty')}
          <label className="field"><span>Instructions</span>
            <textarea rows="5" value={form.instructions} onChange={e => set('instructions', e.target.value)} />
          </label>
          <div className="grid2">
            {f('max_parallel', 'Max parallel tasks', { type: 'number', min: 1, max: 10 })}
            {f('daily_token_budget', 'Daily token budget', { type: 'number', min: 0, step: 100000 })}
          </div>
          <label className="field"><span>Owned paths (one glob per line)</span>
            <textarea rows="4" className="mono" value={form.owned_paths} onChange={e => set('owned_paths', e.target.value)} />
          </label>
          <label className="field"><span>Read-only paths (one glob per line)</span>
            <textarea rows="3" className="mono" value={form.readonly_paths} onChange={e => set('readonly_paths', e.target.value)} />
          </label>
          <fieldset className="perms">
            <legend>Permissions</legend>
            {PERMS.map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={!!form.permissions[k]} onChange={e => set('permissions', { ...form.permissions, [k]: e.target.checked })} />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving' : 'Save profile'}</Button>
            <Button variant="ghost" onClick={() => { setForm(toForm(a)); setSaved(false) }}>Discard changes</Button>
            {saved && <span className="ok small" role="status">Saved</span>}
          </div>
          <ErrorText error={saveError} />
        </form>
      </details>
    </section>
  )
}
