import { useState } from 'react'
import { api } from '../api.js'
import { Badge, Button, ConfirmButton, ErrorText, More, Sheet, StatusDot, initials, tokens, useAction } from '../ui.jsx'
import Terminal from './Terminal.jsx'
import PermissionCard from './Permission.jsx'
import '../agent.css'

const HAND_BACK = 'The owner worked on this in a terminal and handed it back. Check git status and git log, then continue the task.'

export const stateOf = r => (r?.status === 'running' ? r.state : 'idle')

// One agent's live run: Home's terminal pane, with pause, stop, message, take over and its permission requests.
export function Tile({ a, expanded, onQuick }) {
  const r = a.run
  const state = stateOf(r)
  const liveRun = r?.status === 'running'
  const [text, setText] = useState('')
  const [handoff, setHandoff] = useState(null)
  const [run, busy, error] = useAction()
  const post = (path, body) => run(() => api(`/runs/${r.id}/${path}`, { method: 'POST', body }))
  const send = e => {
    e.preventDefault()
    const t = text.trim()
    if (t) post('send', { text: t }).then(() => setText(''))
  }
  // A terminal run hands over the keyboard in place; an older stream-json run gets the resume command for your own terminal.
  const takeOver = () => run(async () => { const h = await api(`/runs/${r.id}/handoff`, { method: 'POST' }); if (!h.terminal) setHandoff(h) })
  const pct = a.daily_token_budget ? Math.min(100, Math.round((a.tokens_today / a.daily_token_budget) * 100)) : 0

  return (
    <article className={`card tile ${expanded ? 'expanded' : ''}`} aria-label={a.name}>
      <header className="tile-head">
        <span className="avatar" aria-hidden="true">{initials(a.name)}</span>
        <div className="grow">
          <div className="row"><a className="title" href={`#/agent/${a.id}`}>{a.name}</a> <StatusDot status={a.status} /></div>
          <div className="muted small live">{liveRun ? (r.task_title || r.kind) : r ? `Last: ${r.task_title || r.kind}, ${r.status}` : a.role}</div>
        </div>
        <Badge status={state}>{state.replace('_', ' ')}</Badge>
      </header>
      <div className="meter" title={`${tokens(a.tokens_today)} of ${tokens(a.daily_token_budget)} tokens today`}>
        <span style={{ width: `${pct}%` }} className={pct >= 90 ? 'hot' : ''} />
      </div>
      {liveRun && r.last_event && <p className="mono muted small live">{r.last_event}</p>}
      <Terminal run={r} drive={expanded} interactive={liveRun && state === 'handed_off'} className={expanded ? 'tall' : ''} />
      {liveRun && (r.pending_permission || []).map(req => <Permission key={req.request_id} runId={r.id} req={req} />)}
      {liveRun && state !== 'handed_off' && (
        <form className="row tell" onSubmit={send}>
          <label className="sr-only" htmlFor={`tell-${a.id}`}>Message to {a.name}</label>
          <input id={`tell-${a.id}`} value={text} onChange={e => setText(e.target.value)} placeholder={`Tell ${a.name}…`} />
          <Button type="submit" disabled={busy || !text.trim()}>Send</Button>
        </form>
      )}
      <div className="actions">
        {liveRun && (state === 'running' || state === 'waiting') && <Button small disabled={busy} onClick={() => post('interrupt')}>Pause</Button>}
        {liveRun && <ConfirmButton small variant="danger" confirm={r.task_id ? 'Stop this task' : 'Stop this run'} disabled={busy} onConfirm={() => post('kill')}>Stop</ConfirmButton>}
        {liveRun && state === 'paused' && <Button small variant="primary" disabled={busy} onClick={() => post('resume')}>Resume</Button>}
        {liveRun && state === 'handed_off' && <Button small variant="primary" disabled={busy} onClick={() => post('resume', { text: HAND_BACK })}>Hand back</Button>}
        {((liveRun && r.session_id && state !== 'handed_off') || a.owned_paths?.length > 0) && (
          <More>
            {liveRun && r.session_id && state !== 'handed_off' && <Button variant="ghost" disabled={busy} onClick={takeOver}>Take over the keyboard</Button>}
            {a.owned_paths?.length > 0 && <Button variant="ghost" onClick={onQuick}>Quick task</Button>}
          </More>
        )}
      </div>
      <ErrorText error={error} />
      {handoff && (
        <Sheet title={`Take over from ${a.name}`} onClose={() => setHandoff(null)}>
          <div className="stack">
            <p>{a.name} is stopped. Continue the same session in your own terminal:</p>
            <pre className="code">cd "{handoff.cwd}"{'\n'}{handoff.command}</pre>
            <div className="actions">
              <Button onClick={() => navigator.clipboard?.writeText(`cd "${handoff.cwd}" && ${handoff.command}`)}>Copy</Button>
            </div>
            <p className="muted small">Exit your terminal session when you are done, then press Hand back on the tile so {a.name} finishes the task.</p>
          </div>
        </Sheet>
      )}
    </article>
  )
}

export function Permission({ runId, req, who }) {
  return <PermissionCard req={req} who={who}
    onAnswer={(allow, remember) => api(`/runs/${runId}/permission`, { method: 'POST', body: { request_id: req.request_id, allow, remember } })} />
}
