import { useState } from 'react'
import { api, useData, useEvents } from '../api.js'
import { Button, ConfirmButton, Empty, ErrorText, Sheet, StatusDot, initials, tokens, useAction } from '../ui.jsx'

export default function Team({ pid }) {
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

  return (
    <section className="page stack">
      <div className="row">
        <h1 className="grow">Team</h1>
        <Button variant="primary" onClick={() => setAdding(true)}>Add agent</Button>
      </div>
      <ErrorText error={error} />
      {agents?.length === 0 && <Empty>No agents. Add one from a template.</Empty>}
      <ul className="team">
        {agents?.map(a => <AgentCard key={a.id} a={a} lastEvent={a.status === 'working' ? live[a.id] || a.last_event : null} reload={reload} />)}
      </ul>
      {adding && <AddAgent pid={pid} onClose={() => setAdding(false)} />}
    </section>
  )
}

function AgentCard({ a, lastEvent, reload }) {
  const [run, busy, error] = useAction()
  const post = (path, method = 'POST') => run(async () => { await api(`/agents/${a.id}${path}`, { method }); reload() })
  return (
    <li className="card agent-card">
      <a className="agent-link" href={`#/agent/${a.id}`}>
        <span className="avatar" aria-hidden="true">{initials(a.name)}</span>
        <span className="grow">
          <span className="title">{a.name} <StatusDot status={a.status} /></span>
          <span className="muted small">{a.role}{a.specialty ? `, ${a.specialty}` : ''}</span>
        </span>
        <span className="muted small" title="Tokens today">{tokens(a.tokens_today)}</span>
      </a>
      <div className="agent-now small">
        {a.current_task ? <span>On: {a.current_task}</span> : <span className="muted">{a.status === 'paused' ? 'Paused' : 'No current task'}</span>}
        {lastEvent && <span className="mono muted live">{lastEvent}</span>}
      </div>
      <div className="actions">
        <Button small disabled={busy} onClick={() => post('/clone')}>Clone</Button>
        {a.status === 'paused'
          ? <Button small disabled={busy} onClick={() => post('/resume')}>Resume</Button>
          : <Button small disabled={busy} onClick={() => post('/pause')}>Pause</Button>}
        {a.removable && a.role !== 'orchestrator'
          ? <ConfirmButton small variant="ghost" confirm={`Remove ${a.name}`} disabled={busy} onConfirm={() => post('', 'DELETE')}>Remove</ConfirmButton>
          : null}
      </div>
      <ErrorText error={error} />
    </li>
  )
}

function AddAgent({ pid, onClose }) {
  const [templates] = useData('/templates')
  const [name, setName] = useState('')
  const [run, busy, error] = useAction()
  const create = body => run(async () => {
    const a = await api(`/projects/${pid}/agents`, { method: 'POST', body })
    onClose()
    if (a?.id) location.hash = `#/agent/${a.id}`
  })
  return (
    <Sheet title="Add agent" onClose={onClose}>
      <div className="stack">
        <h3>From a template</h3>
        <ul className="list">
          {templates?.filter(t => t.role !== 'orchestrator').map(t => (
            <li key={t.role} className="row-card card">
              <span className="grow"><span className="title">{t.name}</span><span className="muted small"> {t.specialty}</span></span>
              <Button small disabled={busy} onClick={() => create({ role: t.role })}>Add</Button>
            </li>
          ))}
        </ul>
        <h3>Blank</h3>
        <form className="row" onSubmit={e => { e.preventDefault(); create({ role: 'custom', name: name.trim() }) }}>
          <label className="field grow"><span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} required placeholder="Docs Writer" />
          </label>
          <Button type="submit" disabled={busy || !name.trim()}>Create</Button>
        </form>
        <ErrorText error={error} />
      </div>
    </Sheet>
  )
}
