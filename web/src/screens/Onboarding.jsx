import { useEffect, useRef, useState } from 'react'
import { api, useData, useEvents } from '../api.js'
import { Ago, Button, ErrorText, useAction } from '../ui.jsx'
import { Md } from '../components/Transcript.jsx'
import Working from '../components/Working.jsx'

const WHO = { user: 'You', onboarding: 'Onboarding', system: 'Crew' }

// The onboarding interview, then the office proposal to approve.
export default function Onboarding({ pid, project, floors }) {
  const [data, , error] = useData(`/projects/${pid}/onboarding`, ev => ev.project_id === pid && (ev.type === 'project' || (ev.type === 'message' && ev.data.channel === 'onboarding')))
  // The live onboarding run, from the project detail on arrival and from run events after that.
  const [busyRun, setBusyRun] = useState(() => project?.running_runs?.find(r => r.kind === 'onboarding') || null)
  useEvents(ev => { if (ev.project_id === pid && ev.type === 'run' && ev.data.kind === 'onboarding') setBusyRun(ev.data.status === 'running' ? ev.data : null) })
  const [text, setText] = useState('')
  const [run, busy, sendError] = useAction()
  const end = useRef()
  const n = data?.messages.length
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [n])

  const status = data?.status || project?.onboarding_status
  const talking = ['interviewing', 'proposed'].includes(status)
  const send = e => {
    e?.preventDefault()
    const t = text.trim()
    if (!t) return
    run(async () => { await api(`/projects/${pid}/onboarding`, { method: 'POST', body: { text: t } }); setText(''); setBusyRun(r => r || {}) })
  }
  const rerun = () => run(() => api(`/projects/${pid}/onboard`, { method: 'POST' }))

  return (
    <section className="chat">
      <h1>Onboarding</h1>
      <ErrorText error={error} />
      <ol className="messages">
        {data?.messages.map(m => (
          <li key={m.id} className={`msg ${m.role}`}>
            <div className="meta">{WHO[m.role] || m.role} <span className="muted"><Ago at={m.created_at} /></span></div>
            <div className="bubble"><Md text={m.text} /></div>
          </li>
        ))}
      </ol>
      {(busyRun || status === 'running') && <Working text={status === 'running' ? 'Writing CLAUDE.md, the playbook and the brief' : 'Onboarding is reading and thinking'} lastEvent={busyRun?.last_event} since={busyRun?.started_at} />}
      {status === 'proposed' && data?.proposal && <Proposal pid={pid} proposal={data.proposal} floors={floors} />}
      {talking ? (
        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="ob-text">Answer the Onboarding agent</label>
          <textarea id="ob-text" rows="2" placeholder={status === 'proposed' ? 'Ask for changes, e.g. add a mobile dev, drop Marketing (Ctrl+Enter sends)' : 'Your answer (Ctrl+Enter sends)'}
            value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() }} />
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>Send</Button>
        </form>
      ) : status && status !== 'running' && (
        <div className="actions"><Button disabled={busy} onClick={rerun}>{status === 'failed' ? 'Retry onboarding' : 'Re-run onboarding'}</Button><a className="btn ghost" href="#/home">Go to the office</a></div>
      )}
      <ErrorText error={sendError} />
      <div ref={end} />
    </section>
  )
}

function Proposal({ pid, proposal, floors }) {
  const [keep, setKeep] = useState(() => new Set(proposal.agents.map((_, i) => i)))
  useEffect(() => setKeep(new Set(proposal.agents.map((_, i) => i))), [proposal])
  const [run, busy, error] = useAction()
  const floorOf = k => floors?.find(f => f.key === k) || { key: k, name: k }
  const toggle = i => setKeep(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })
  const approve = () => run(() => api(`/projects/${pid}/onboarding/apply`, { method: 'POST', body: { keep: [...keep] } }))
  return (
    <article className="card stack proposal" aria-label="Office proposal">
      <h2>Proposed office</h2>
      {proposal.brief && <details><summary className="small">Project brief (every agent reads this)</summary><div className="vault-body"><Md text={proposal.brief} /></div></details>}
      {proposal.floors.map(k => {
        const f = floorOf(k)
        return (
          <section key={k} className="stack" style={{ '--floor': f.color }}>
            <h3><i className="floor-chip" aria-hidden="true" /> {f.name} floor{f.folder ? <span className="muted small mono"> {f.folder}/</span> : null}</h3>
            <ul className="list">
              {proposal.agents.map((a, i) => a.floor !== k ? null : (
                <li key={i}>
                  <label className="check">
                    <input type="checkbox" checked={a.locked || keep.has(i)} disabled={a.locked} onChange={() => toggle(i)} />
                    <span><b>{a.name}</b> <span className="muted small">{a.specialty}{a.template ? '' : `, custom, owns ${a.owned_paths.join(', ')}`}{a.locked ? ', always on' : ''}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {proposal.first_order && <p className="small"><b>First order for Tech</b> (waits for your approval): {proposal.first_order}</p>}
      <div className="actions">
        <Button variant="primary" disabled={busy} onClick={approve}>{busy ? 'Approving' : 'Approve this office'}</Button>
        <span className="muted small">Want changes? Say so below and a revised proposal comes back.</span>
      </div>
      <ErrorText error={error} />
    </article>
  )
}
