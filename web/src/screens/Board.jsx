import { useState } from 'react'
import { api, on, useData } from '../api.js'
import { Ago, Badge, Button, ConfirmButton, Empty, ErrorText, Sheet, ghUrl, orderStatus, taskStatus, tokens, useAction } from '../ui.jsx'
import TaskFacts from '../components/TaskFacts.jsx'
import RetryNote from '../components/RetryNote.jsx'
import Shipped from '../components/Shipped.jsx'

// Columns hold work in flight only: merged work lives in Shipped, blocked work in the banner above.
const COLS = [
  ['planned', 'Planned', t => t.status === 'planned'],
  ['doing', 'In progress', t => t.status === 'in_progress'],
  ['check', 'Being checked', t => t.status === 'in_review' || t.status === 'qa'],
  ['merge', 'Ready to merge', t => t.status === 'done' && !t.merged],
]
const inFlight = t => t.status === 'blocked' || COLS.some(([, , f]) => f(t))

export default function Board({ pid, project, orderId }) {
  const [tasks, , error] = useData(`/projects/${pid}/tasks`, on(pid, 'task'))
  const [agents] = useData(`/projects/${pid}/agents`, on(pid, 'agent'))
  const [orders] = useData(`/projects/${pid}/orders`, on(pid, 'order'))
  const [agent, setAgent] = useState('')
  const [order, setOrder] = useState(orderId ? String(orderId) : '')
  const [showDone, setShowDone] = useState(false)
  const [openId, setOpenId] = useState(null)
  // Nothing picked: Shipped when nothing is in flight, so an idle office opens on what it delivered.
  const [picked, setMode] = useState(orderId ? 'flight' : null)
  const mode = picked || (tasks && !tasks.some(inFlight) ? 'shipped' : 'flight')

  const shown = (tasks || []).filter(t => (!agent || String(t.agent_id) === agent) && (!order || String(t.order_id) === order))
  // Phone list: one group per order, newest first, finished work hidden unless asked for.
  const groups = (orders || []).filter(o => !order || String(o.id) === order).map(o => ({
    o, list: shown.filter(t => t.order_id === o.id && t.status !== 'canceled' && (showDone || t.status !== 'done')),
  })).filter(g => g.list.length)
  const card = t => <TaskCard key={t.id} t={t} onOpen={() => setOpenId(t.id)} />

  const blocked = shown.filter(t => t.status === 'blocked')
  const switcher = (
    <div className="mode" role="tablist" aria-label="Board view">
      <button type="button" role="tab" aria-selected={mode === 'flight'} onClick={() => setMode('flight')}>In flight</button>
      <button type="button" role="tab" aria-selected={mode === 'shipped'} onClick={() => setMode('shipped')}>Shipped</button>
    </div>
  )
  if (mode === 'shipped') return <section className="page board-page stack">{switcher}<Shipped pid={pid} /></section>

  return (
    <section className="page board-page">
      {switcher}
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
        <label className="check done-toggle">
          <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> Show done tasks
        </label>
      </div>
      <ErrorText error={error} />
      <div className="board-list stack">
        {tasks && !groups.length && <Empty>{showDone ? 'No tasks yet.' : 'Nothing in flight. Done tasks are hidden.'}</Empty>}
        {groups.map(({ o, list }) => (
          <details key={o.id} className="group" open>
            <summary>
              <span className="grow title clip">#{o.id} {o.plan?.summary || o.text}</span>
              <Badge status={orderStatus(o)} />
              {o.total > 0 && <span className="muted small">{o.done}/{o.total}, ${Number(o.cost_usd || 0).toFixed(2)}</span>}
            </summary>
            <div className="list">{list.map(card)}</div>
          </details>
        ))}
      </div>
      {blocked.length > 0 && (
        <section className="banner blocked-banner" aria-label="Blocked">
          <b>{blocked.length} blocked</b>
          <div className="list">{blocked.map(card)}</div>
        </section>
      )}
      <div className="board">
        {COLS.map(([id, name, f]) => [id, name, shown.filter(f)]).filter(([, , list]) => list.length).map(([id, name, list]) => (
          <section key={id} className="column" aria-label={name}>
            <h2>{name} <span className="n">{list.length}</span></h2>
            {list.map(card)}
          </section>
        ))}
        {tasks && !COLS.some(([, , f]) => shown.some(f)) && <Empty>Nothing in flight.</Empty>}
      </div>
      {openId && <TaskSheet id={openId} pid={pid} repo={project.repo} onClose={() => setOpenId(null)} />}
    </section>
  )
}

function TaskCard({ t, onOpen }) {
  return (
    <button type="button" className="task-card" onClick={onOpen}>
      <span className="row"><span className="title grow">{t.title}</span><Badge status={taskStatus(t)} /></span>
      <span className="meta">
        <span className="mono">#{t.id}</span>
        <span className="pill">{t.size}</span>
        {t.agent_name && <span>{t.agent_name}</span>}
        {t.attempts > 0 && <span className="warn">try {t.attempts + 1}</span>}
        {t.pr_number && <span>PR #{t.pr_number}</span>}
        {t.status === 'planned' && t.wait_reason && <span className="wait">{t.wait_reason}</span>}
      </span>
    </button>
  )
}

function TaskSheet({ id, pid, repo, onClose }) {
  const [t, reload, error] = useData(`/tasks/${id}`, ev => ev.project_id === pid && (
    (ev.type === 'task' && ev.data.id === id) ||
    (ev.type === 'activity' && ev.data.task_id === id) ||
    (ev.type === 'run' && ev.data.task_id === id)))
  const [run, busy, actError] = useAction()
  const retry = () => run(async () => { await api(`/tasks/${id}/retry`, { method: 'POST' }); reload() })
  const cancel = () => run(async () => { await api(`/tasks/${id}/cancel`, { method: 'POST' }); reload() })

  return (
    <Sheet title={t ? t.title : 'Task'} onClose={onClose}>
      <ErrorText error={error} />
      {!t ? <p className="muted">Loading</p> : (
        <div className="stack">
          <div className="row wrap">
            <Badge status={taskStatus(t)} />
            <span className="pill">{t.role}</span>
            <span className="pill">size {t.size}</span>
            <span className="muted small">attempts {t.attempts}</span>
          </div>
          <div className="row wrap small">
            {t.pr_url && <a href={t.pr_url} target="_blank" rel="noreferrer">PR #{t.pr_number}</a>}
            {t.issue_number && <a href={ghUrl(repo, 'issues', t.issue_number)} target="_blank" rel="noreferrer">Issue #{t.issue_number}</a>}
            {t.branch && <span className="mono muted">{t.branch}</span>}
          </div>
          <TaskFacts t={t} />
          {!['done', 'canceled'].includes(t.status) && !t.merged && (
            <div className="actions">
              {t.status === 'blocked' && <Button variant="primary" disabled={busy} onClick={retry}>Retry task</Button>}
              {t.status === 'blocked' && <RetryNote onRetry={async note => { await api(`/tasks/${id}/retry`, { method: 'POST', body: { note } }); reload() }} />}
              <ConfirmButton variant="ghost" confirm="Cancel this task for good" disabled={busy} onConfirm={cancel}>Cancel task</ConfirmButton>
              <ErrorText error={actError} />
            </div>
          )}
          {t.status === 'canceled' && <p className="muted small">Canceled. The rest of the order went on without it.</p>}
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
                    <span className="muted small"> <Ago at={a.created_at} /></span>
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
          <span className="grow mono small">{r.status === 'running' ? r.last_event : ''}</span>
          <span className="muted small">{tokens(r.input_tokens + r.output_tokens)} tok, ${Number(r.cost_usd || 0).toFixed(2)}, <Ago at={r.started_at} /></span>
        </summary>
        <p className="pre small">{r.result_text || r.last_event || 'No output yet'}</p>
      </details>
    </li>
  )
}
