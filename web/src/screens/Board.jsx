import { useState } from 'react'
import { api, on, useData } from '../api.js'
import { Badge, Button, Empty, ErrorText, Sheet, ago, ghUrl, label, tokens, useAction } from '../ui.jsx'

const COLS = [['planned', 'Planned'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['qa', 'QA'], ['done', 'Done'], ['blocked', 'Blocked']]

export default function Board({ pid, project, orderId }) {
  const [tasks, , error] = useData(`/projects/${pid}/tasks`, on(pid, 'task'))
  const [agents] = useData(`/projects/${pid}/agents`, on(pid, 'agent'))
  const [orders] = useData(`/projects/${pid}/orders`, on(pid, 'order'))
  const [agent, setAgent] = useState('')
  const [order, setOrder] = useState(orderId ? String(orderId) : '')
  const [col, setCol] = useState('in_progress')
  const [openId, setOpenId] = useState(null)

  const shown = (tasks || []).filter(t => (!agent || String(t.agent_id) === agent) && (!order || String(t.order_id) === order))

  return (
    <section className="page board-page">
      <div className="filters">
        <label className="field">
          <span>Agent</span>
          <select value={agent} onChange={e => setAgent(e.target.value)}>
            <option value="">All agents</option>
            {agents?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Order</span>
          <select value={order} onChange={e => setOrder(e.target.value)}>
            <option value="">All orders</option>
            {orders?.map(o => <option key={o.id} value={o.id}>#{o.id} {o.plan?.summary || o.text}</option>)}
          </select>
        </label>
      </div>
      <ErrorText error={error} />
      <div className="col-pick" role="group" aria-label="Column">
        {COLS.map(([id, name]) => (
          <Button key={id} small variant={col === id ? 'primary' : 'ghost'} aria-pressed={col === id} onClick={() => setCol(id)}>
            {name} <span className="n">{shown.filter(t => t.status === id).length}</span>
          </Button>
        ))}
      </div>
      <div className="board">
        {COLS.map(([id, name]) => {
          const list = shown.filter(t => t.status === id)
          return (
            <section key={id} className={`column ${col === id ? 'active' : ''}`} aria-label={name}>
              <h2>{name} <span className="n">{list.length}</span></h2>
              {list.length === 0 ? <Empty>Nothing here</Empty> : list.map(t => (
                <button key={t.id} type="button" className="task-card" onClick={() => setOpenId(t.id)}>
                  <span className="title">{t.title}</span>
                  <span className="meta">
                    <span className="mono">#{t.id}</span>
                    <span className="pill">{t.role}</span>
                    <span className="pill">{t.size}</span>
                    {t.agent_name && <span>{t.agent_name}</span>}
                    {t.attempts > 0 && <span className="warn">try {t.attempts + 1}</span>}
                    {t.pr_number && <span>PR #{t.pr_number}</span>}
                    {t.merged ? <span className="ok">merged</span> : null}
                  </span>
                </button>
              ))}
            </section>
          )
        })}
      </div>
      {openId && <TaskSheet id={openId} pid={pid} repo={project.repo} onClose={() => setOpenId(null)} />}
    </section>
  )
}

function TaskSheet({ id, pid, repo, onClose }) {
  const [t, reload, error] = useData(`/tasks/${id}`, ev => ev.project_id === pid && (
    (ev.type === 'task' && ev.data.id === id) ||
    (ev.type === 'activity' && ev.data.task_id === id) ||
    (ev.type === 'run' && ev.data.task_id === id)))
  const [run, busy, actError] = useAction()
  const retry = () => run(async () => { await api(`/tasks/${id}/retry`, { method: 'POST' }); reload() })

  return (
    <Sheet title={t ? t.title : 'Task'} onClose={onClose}>
      <ErrorText error={error} />
      {!t ? <p className="muted">Loading</p> : (
        <div className="stack">
          <div className="row wrap">
            <Badge status={t.status} />
            <span className="pill">{t.role}</span>
            <span className="pill">size {t.size}</span>
            <span className="muted small">attempts {t.attempts}</span>
            {t.merged ? <span className="ok small">merged</span> : null}
          </div>
          <div className="row wrap small">
            {t.pr_url && <a href={t.pr_url} target="_blank" rel="noreferrer">PR #{t.pr_number}</a>}
            {t.issue_number && <a href={ghUrl(repo, 'issues', t.issue_number)} target="_blank" rel="noreferrer">Issue #{t.issue_number}</a>}
            {t.branch && <span className="mono muted">{t.branch}</span>}
          </div>
          {t.status === 'blocked' && (
            <div className="actions">
              <Button variant="primary" disabled={busy} onClick={retry}>Retry task</Button>
              <ErrorText error={actError} />
            </div>
          )}
          {t.description && <section><h3>Description</h3><p className="pre">{t.description}</p></section>}
          {t.acceptance?.length > 0 && (
            <section><h3>Acceptance</h3><ul className="checks">{t.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul></section>
          )}
          {t.files?.length > 0 && <section><h3>Files</h3><p className="mono small">{t.files.join('  ')}</p></section>}
          {t.notes && <section><h3>Notes for next attempt</h3><p className="pre notes">{t.notes}</p></section>}
          <section>
            <h3>Runs</h3>
            {t.runs?.length ? <ul className="list">{t.runs.map(r => <RunItem key={r.id} r={r} />)}</ul> : <Empty>No runs yet</Empty>}
          </section>
          <section>
            <h3>Activity</h3>
            {t.activity?.length ? (
              <ul className="feed">
                {t.activity.map(a => (
                  <li key={a.id}>
                    <span className="pill">{a.kind}</span> {a.link ? <a href={a.link} target="_blank" rel="noreferrer">{a.text}</a> : a.text}
                    <span className="muted small"> {ago(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty>No activity yet</Empty>}
          </section>
        </div>
      )}
    </Sheet>
  )
}

export function RunItem({ r }) {
  return (
    <li className="run">
      <details>
        <summary>
          <Badge status={r.status} />
          <span className="pill">{r.kind}</span>
          <span className="grow mono small">{r.status === 'running' ? r.last_event : label(r.status)}</span>
          <span className="muted small">{tokens(r.input_tokens + r.output_tokens)} tok, ${Number(r.cost_usd || 0).toFixed(2)}, {ago(r.started_at)}</span>
        </summary>
        <p className="pre small">{r.result_text || r.last_event || 'No output yet'}</p>
      </details>
    </li>
  )
}
