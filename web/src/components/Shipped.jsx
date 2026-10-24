import { on, useData } from '../api.js'
import { Empty, ErrorText, ago, tokens } from '../ui.jsx'

// Monday 00:00 local of the week a timestamp falls in. Server times are UTC without a zone.
const weekOf = s => {
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

// What the office delivered: merged tasks newest first, with weekly totals on top.
export default function Shipped({ pid }) {
  const [rows, , error] = useData(`/projects/${pid}/shipped`, on(pid, 'task'))
  if (error) return <ErrorText error={error} />
  if (!rows) return <p className="muted">Loading</p>
  if (!rows.length) return <Empty>Nothing shipped yet. Merged PRs show up here.</Empty>
  const weeks = Object.entries(Object.groupBy(rows, r => weekOf(r.merged_at))).sort((a, b) => b[0] - a[0]).slice(0, 4)
  const thisWeek = weekOf(new Date().toISOString().slice(0, 19).replace('T', ' '))
  return (
    <div className="stack shipped">
      <ul className="week-totals" aria-label="Weekly totals">
        {weeks.map(([w, list]) => (
          <li key={w} className="card">
            <span className="muted small">{Number(w) === thisWeek ? 'This week' : `Week of ${new Date(Number(w)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}</span>
            <b>{list.length} shipped</b>
            <span className="small">${list.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <ul className="list">
        {rows.map(r => (
          <li key={r.id} className="card shipped-item">
            <div className="row wrap">
              <span className="grow title">{r.title}</span>
              {r.pr_url && <a className="small" href={r.pr_url} target="_blank" rel="noreferrer">PR #{r.pr_number}</a>}
            </div>
            <div className="row wrap small muted">
              {r.agent_name && <span>{r.agent_name}</span>}
              <span title={r.merged_at}>{ago(r.merged_at)}</span>
              <span>${r.cost_usd.toFixed(2)}, {tokens(r.tokens)} tok</span>
              {r.order_title && <a className="clip" href={`#/board/${r.order_id}`}>{r.order_title}</a>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
