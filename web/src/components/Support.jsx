import { useLayoutEffect, useRef, useState } from 'react'
import { api, on, useData } from '../api.js'
import { Button, ConfirmButton, Empty, ErrorText, ago, useAction } from '../ui.jsx'
import Working from './Working.jsx'
import { Md } from './Transcript.jsx'
import { ServiceLog } from './Terminal.jsx'

// The Support conversation: chores in, short answers out. A reply can carry an order Support suggests for the team.
export function SupportThread({ pid, support, floor = 'tech', onSentToTeam }) {
  const [msgs] = useData(`/projects/${pid}/messages?channel=support`, ev => ev.type === 'message' && ev.project_id === pid && ev.data.channel === 'support')
  const [run, busy, error] = useAction()
  const box = useRef()
  const n = msgs?.length
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [n])
  const working = support?.run?.status === 'running'
  const lastReply = msgs?.findLast(m => m.role === 'support')
  const lastAsk = msgs?.findLast(m => m.role === 'user')

  const toTeam = text => run(async () => { await api(`/projects/${pid}/messages`, { method: 'POST', body: { text, floor } }); onSentToTeam?.() })
  const retry = () => run(() => api(`/projects/${pid}/support`, { method: 'POST', body: { text: lastAsk.text, model: 'sonnet' } }))

  return (
    <div className="support-thread" ref={box}>
      {!msgs?.length && <p className="lane-empty">Ask Support for chores: start the dev server, run the tests, how many users signed up today, why the build fails. No PRs, no review.</p>}
      {msgs?.map(m => (
        <div key={m.id} className={`sp ${m.role === 'user' ? 'mine' : ''}`}>
          <div className="sp-bubble"><Md text={m.text} /></div>
          {m.suggest && (
            <div className="sp-suggest">
              <span className="small">Suggested order for the team:</span>
              <p className="small pre">{m.suggest}</p>
              <Button small variant="primary" disabled={busy} onClick={() => toTeam(m.suggest)}>Send to the team</Button>
            </div>
          )}
          <span className="sp-meta">{m.role === 'user' ? 'You' : 'Support'}, {ago(m.created_at)}
            {m === lastReply && lastAsk && lastAsk.id < m.id && !working && (
              <button type="button" className="linkish" disabled={busy} onClick={retry} title="Ask the same thing again on Sonnet">Try again with Sonnet</button>
            )}
          </span>
        </div>
      ))}
      {working && <Working text="Support is on it" lastEvent={support.run.last_event} since={support.run.started_at} />}
      <ErrorText error={error} />
    </div>
  )
}

// Running services as chips: name, link, stop. Opens the full list from the chip row.
export function ServiceChips({ services, onOpen }) {
  const up = (services || []).filter(s => s.status === 'running')
  if (!up.length) return null
  return (
    <div className="svc-chips">
      {up.map(s => (
        <span key={s.id} className="svc-chip">
          <i className="svc-dot" />{s.name}
          {s.url && <a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\//, '')}</a>}
        </span>
      ))}
      <button type="button" className="linkish" onClick={onOpen}>Logs</button>
    </div>
  )
}

export function ServicesSheetBody({ pid }) {
  const [services] = useData(`/projects/${pid}/services`, on(pid, 'service'))
  const [open, setOpen] = useState(null)
  const [run, busy, error] = useAction()
  if (!services) return <p className="muted">Loading</p>
  if (!services.length) return <Empty>No services yet. Ask Support to start your dev server.</Empty>
  const shown = services.find(s => s.id === open) || services.find(s => s.status === 'running') || services[0]
  return (
    <div className="stack">
      <ul className="list">
        {services.map(s => (
          <li key={s.id} className={`card svc-row ${shown?.id === s.id ? 'on' : ''}`}>
            <button type="button" className="svc-pick" onClick={() => setOpen(s.id)} aria-pressed={shown?.id === s.id}>
              <i className={`svc-dot ${s.status}`} /><b>{s.name}</b> <span className="mono small muted">{s.command}</span>
            </button>
            <span className="row wrap small">
              <span className="muted">{s.status}{s.status === 'exited' && s.exit_code != null ? ` (code ${s.exit_code})` : ''}, {ago(s.started_at)}</span>
              {s.url && s.status === 'running' && <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>}
              <span className="grow" />
              {s.status === 'running'
                ? <><Button small disabled={busy} onClick={() => run(() => api(`/services/${s.id}/restart`, { method: 'POST' }))}>Restart</Button>
                  <ConfirmButton small variant="ghost" confirm="Stop it" disabled={busy} onConfirm={() => run(() => api(`/services/${s.id}/stop`, { method: 'POST' }))}>Stop</ConfirmButton></>
                : <><Button small disabled={busy} onClick={() => run(() => api(`/services/${s.id}/restart`, { method: 'POST' }))}>Start again</Button>
                  <Button small variant="ghost" disabled={busy} onClick={() => run(() => api(`/services/${s.id}`, { method: 'DELETE' }))}>Remove</Button></>}
            </span>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
      {shown && <ServiceLog key={`${shown.id}-${shown.status}`} service={shown} className="svc-log" />}
    </div>
  )
}
