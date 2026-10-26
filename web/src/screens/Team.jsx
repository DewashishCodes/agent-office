import { useState } from 'react'
import { api, useData, useEvents } from '../api.js'
import { Button, ConfirmButton, Empty, ErrorText, More, Sheet, Skeleton, StatusDot, initials, tokens, useAction } from '../ui.jsx'
import QuickTask from '../components/QuickTask.jsx'
import ModelEffort from '../components/ModelEffort.jsx'

const ROLES = ['custom', 'frontend', 'backend', 'planner', 'reviewer', 'qa']

export default function Team({ pid, floors, floor }) {
  const [agents, reload, error] = useData(`/projects/${pid}/agents`, ev => ev.project_id === pid &&
    (ev.type === 'agent' || ev.type === 'task' || (ev.type === 'run' && ev.data.status !== 'running')))
  // Live last_event straight from run events, so a busy agent does not trigger a refetch every second.
  const [live, setLive] = useState({})
  useEvents(ev => {
    if (ev.type === 'run' && ev.project_id === pid && ev.data.agent_id && ev.data.status === 'running') {
      setLive(l => ({ ...l, [ev.data.agent_id]: ev.data.last_event }))
    }
  })
  const [adding, setAdding] = useState(false)
  const [quick, setQuick] = useState(null)

  return (
    <section className="page stack">
      <div className="row">
        <h1 className="grow">Team</h1>
        <Button variant="primary" onClick={() => setAdding(true)}>Add agent</Button>
      </div>
      <ErrorText error={error} />
      {!agents && !error && <Skeleton />}
      {agents?.length === 0 && <Empty set="hello" title="No agents yet">Run onboarding from Projects, or add one from a template.</Empty>}
      <ul className="team">
        {agents?.map(a => <AgentCard key={a.id} a={a} lastEvent={a.status === 'working' ? live[a.id] || a.last_event : null} floors={floors} reload={reload} onQuick={() => setQuick(a.name)} />)}
      </ul>
      {adding && <AddAgent pid={pid} floors={floors} floor={floor} onClose={() => setAdding(false)} />}
      {quick && <QuickTask pid={pid} agent={quick} onClose={() => setQuick(null)} />}
    </section>
  )
}

function AgentCard({ a, floors, lastEvent, reload, onQuick }) {
  const [run, busy, error] = useAction()
  const post = (path, method = 'POST') => run(async () => { await api(`/agents/${a.id}${path}`, { method }); reload() })
  return (
    <li className="card agent-card">
      <a className="agent-link" href={`#/agent/${a.id}`}>
        <span className="avatar" aria-hidden="true">{initials(a.name)}</span>
        <span className="grow">
          <span className="title">{a.name} <StatusDot status={a.status} /></span>
          <span className="muted small">{floors?.find(f => f.key === a.floor)?.name || a.floor}, {a.role}{a.specialty ? `, ${a.specialty}` : ''}</span>
        </span>
        <span className="muted small" title="Tokens today">{tokens(a.tokens_today)}</span>
      </a>
      <div className="agent-now small">
        {a.current_task ? <span>On: {a.current_task}</span> : <span className="muted">{a.status === 'paused' ? 'Paused' : 'No current task'}</span>}
        {lastEvent && <span className="mono muted live">{lastEvent}</span>}
      </div>
      <ModelEffort a={a} onSaved={reload} />
      <div className="actions">
        {a.owned_paths?.length > 0 && <Button small onClick={onQuick}>Quick task</Button>}
        {a.status === 'paused'
          ? <Button small disabled={busy} onClick={() => post('/resume')}>Resume</Button>
          : <Button small disabled={busy} onClick={() => post('/pause')}>Pause</Button>}
        <More>
          <a className="btn ghost" href={`#/agent/${a.id}`}>Edit profile</a>
          <Button variant="ghost" disabled={busy} onClick={() => post('/clone')}>Clone</Button>
          {a.removable && a.role !== 'orchestrator'
            ? <ConfirmButton variant="ghost" confirm={`Remove ${a.name}`} disabled={busy} onConfirm={() => post('', 'DELETE')}>Remove</ConfirmButton>
            : null}
        </More>
      </div>
      <ErrorText error={error} />
    </li>
  )
}

function AddAgent({ pid, floors, floor, onClose }) {
  const [templates] = useData('/templates')
  const [role, setRole] = useState('custom')
  const [c, setC] = useState({ name: '', floor: floor || 'tech', specialty: '', instructions: '', owned_paths: '', model: 'sonnet', effort: 'medium' })
  const [run, busy, error] = useAction()
  const create = body => run(async () => {
    const a = await api(`/projects/${pid}/agents`, { method: 'POST', body })
    onClose()
    if (a?.id) location.hash = `#/agent/${a.id}`
  })
  // Same defaults onboarding gives hired agents; without open_pr the agent's work never ships.
  const submit = e => {
    e.preventDefault()
    const body = {
      ...c, role, name: c.name.trim(),
      owned_paths: c.owned_paths.split('\n').map(x => x.trim()).filter(Boolean),
      ...(role === 'custom' && { permissions: { open_pr: true, comment: true, run_tests: c.floor === 'tech', merge: false } }),
    }
    // Blank fields keep the role template's own values instead of wiping them.
    for (const k of ['specialty', 'instructions', 'owned_paths']) if (!body[k].length) delete body[k]
    create(body)
  }
  return (
    <Sheet title="Add agent" onClose={onClose}>
      <div className="stack">
        <h3>From a template</h3>
        <ul className="list">
          {templates?.filter(t => t.role !== 'orchestrator' && t.role !== 'support').map(t => (
            <li key={t.key || t.role} className="row-card card">
              <span className="grow"><span className="title">{t.name}</span><span className="muted small"> {floors?.find(f => f.key === t.floor)?.name}, {t.specialty}</span></span>
              <Button small disabled={busy} onClick={() => create({ role: t.key || t.role })}>Add</Button>
            </li>
          ))}
        </ul>
        <h3>Custom</h3>
        <form className="stack" onSubmit={submit}>
          <div className="grid2">
            <label className="field"><span>Name</span>
              <input value={c.name} onChange={e => setC({ ...c, name: e.target.value })} required placeholder="Docs Writer" />
            </label>
            <label className="field"><span>Role</span>
              <select value={role} onChange={e => setRole(e.target.value)}>{ROLES.map(r => <option key={r}>{r}</option>)}</select>
            </label>
            <label className="field"><span>Floor</span>
              <select value={c.floor} onChange={e => setC({ ...c, floor: e.target.value })}>
                {(floors?.length ? floors : [{ key: 'tech', name: 'Tech' }]).map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Specialty</span>
              <input value={c.specialty} onChange={e => setC({ ...c, specialty: e.target.value })} placeholder="README, guides, API docs" />
            </label>
            <label className="field"><span>Model</span>
              <select value={c.model} onChange={e => setC({ ...c, model: e.target.value })}>{['haiku', 'sonnet', 'opus'].map(x => <option key={x}>{x}</option>)}</select>
            </label>
            <label className="field"><span>Effort</span>
              <select value={c.effort} onChange={e => setC({ ...c, effort: e.target.value })}>{['low', 'medium', 'high', 'xhigh', 'max'].map(x => <option key={x}>{x}</option>)}</select>
            </label>
          </div>
          <label className="field"><span>Instructions</span>
            <textarea rows="3" value={c.instructions} onChange={e => setC({ ...c, instructions: e.target.value })} placeholder="How this agent should work, every task" />
          </label>
          <label className="field"><span>Owned paths, one glob per line (it only gets tasks touching these)</span>
            <textarea rows="3" className="mono" value={c.owned_paths} onChange={e => setC({ ...c, owned_paths: e.target.value })} placeholder={'docs/**\nREADME.md'} />
          </label>
          <div className="actions"><Button type="submit" variant="primary" disabled={busy || !c.name.trim()}>Create agent</Button></div>
        </form>
        <ErrorText error={error} />
      </div>
    </Sheet>
  )
}
