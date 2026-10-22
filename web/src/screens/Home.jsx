import { useState } from 'react'
import { on, useData, useEvents } from '../api.js'
import { Badge, Empty, ErrorText, initials } from '../ui.jsx'
import { Item, PushButton } from './Inbox.jsx'
import { stateOf } from './Wall.jsx'

// One answer to "what needs me": open inbox items first, then orders in flight, then what each agent is doing.
export default function Home({ pid }) {
  const [items, , error] = useData(`/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))
  const [wall, , wallError] = useData(`/projects/${pid}/wall`, ev => ev.project_id === pid &&
    (['agent', 'order', 'task'].includes(ev.type) || (ev.type === 'run' && ev.data.status !== 'running')))
  // Live last_event straight from run events, so a busy agent does not refetch the wall every second.
  const [live, setLive] = useState({})
  useEvents(ev => {
    if (ev.type === 'run' && ev.project_id === pid && ev.data.agent_id) {
      setLive(l => ({ ...l, [ev.data.agent_id]: ev.data }))
    }
  })

  return (
    <section className="page stack">
      <section className="stack" aria-labelledby="needs-you">
        <div className="row wrap">
          <h1 id="needs-you" className="grow">Needs you {items?.length > 0 && <span className="count">{items.length}</span>}</h1>
          <PushButton />
        </div>
        <ErrorText error={error} />
        {items?.length === 0 && <Empty>All clear. Nothing needs you right now.</Empty>}
        <ul className="list">{items?.map(i => <Item key={i.id} i={i} />)}</ul>
        <a className="small" href="#/inbox">Inbox history</a>
      </section>

      <ErrorText error={wallError} />
      {wall && (
        <div className="grid2 home-grid">
          <section className="card stack">
            <div className="row"><h2 className="grow">Orders</h2><a className="small" href="#/command">New order</a></div>
            {wall.orders.length ? (
              <ul className="feed">
                {wall.orders.map(o => {
                  const total = Object.values(o.counts).reduce((s, n) => s + n, 0)
                  const done = o.counts.done || 0
                  return (
                    <li key={o.id}>
                      <a className="order-row" href={`#/board/${o.id}`}>
                        <span className="row"><span className="grow title clip">{o.plan?.summary || o.text}</span><Badge status={o.status} /></span>
                        {total > 0 && (
                          <span className="row small muted">
                            <span className="meter grow"><span style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
                            {done}/{total} done
                          </span>
                        )}
                      </a>
                    </li>
                  )
                })}
              </ul>
            ) : <Empty>No open orders. Give one on Command.</Empty>}
          </section>

          <section className="card stack">
            <div className="row"><h2 className="grow">Agents</h2><a className="small" href="#/wall">Open wall</a></div>
            {wall.agents.length ? (
              <ul className="feed">
                {wall.agents.map(a => {
                  const r = live[a.id] && a.run?.id === live[a.id].id ? { ...a.run, ...live[a.id] } : a.run
                  const state = stateOf(r)
                  return (
                    <li key={a.id}>
                      <a className="agent-link" href={`#/agent/${a.id}`}>
                        <span className="avatar" aria-hidden="true">{initials(a.name)}</span>
                        <span className="grow">
                          <span className="title">{a.name}</span>
                          <span className="muted small clip">
                            {state === 'idle' ? (a.status === 'paused' ? 'Paused' : 'Idle') : `${r.task_title || r.kind}: ${r.last_event || 'starting'}`}
                          </span>
                        </span>
                        <Badge status={state}>{state.replace('_', ' ')}</Badge>
                      </a>
                    </li>
                  )
                })}
              </ul>
            ) : <Empty>No agents yet.</Empty>}
          </section>
        </div>
      )}
    </section>
  )
}
