import { useState } from 'react'
import { on, useData } from '../api.js'
import { Ago, Empty, ErrorText } from '../ui.jsx'

// Everything the office logged for this project, newest first, filterable by kind (order, dispatch, pr, merge, error...).
export default function Activity({ pid }) {
  const [rows, , error] = useData(`/projects/${pid}/activity?limit=500`, on(pid, 'activity'))
  const [kind, setKind] = useState('')
  const kinds = [...new Set((rows || []).map(r => r.kind))].sort()
  const shown = (rows || []).filter(r => !kind || r.kind === kind)
  return (
    <section className="page stack">
      <div className="row wrap">
        <h1 className="grow">Activity</h1>
        <label className="sr-only" htmlFor="activity-kind">Show</label>
        <select id="activity-kind" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">Everything</option>
          {kinds.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      <ErrorText error={error} />
      {rows && !shown.length && <Empty>Nothing logged yet.</Empty>}
      <ul className="list activity">
        {shown.map(r => (
          <li key={r.id} className="activity-row">
            <span className="pill">{r.kind}</span>
            <span className="grow pre small">{r.text}</span>
            <span className="muted small"><Ago at={r.created_at} />{r.link && <> <a href={r.link} target="_blank" rel="noreferrer">Open</a></>}{r.order_id && <> <a href={`#/board/${r.order_id}`}>Order</a></>}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
