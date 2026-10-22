import { useEffect, useRef, useState } from 'react'
import { api, on, useData, useEvents } from '../api.js'
import { Badge, Button, ConfirmButton, Empty, ErrorText, ago, useAction } from '../ui.jsx'
import { Md } from '../components/Transcript.jsx'
import { FloorBar, OpenFloorSheet, currentFloor, openFloors } from '../components/Floors.jsx'

export default function Command({ pid, running, floors, floor: saved, setFloor }) {
  const [agents] = useData(`/projects/${pid}/agents`, on(pid, 'agent'))
  const [templates] = useData('/templates')
  const [adding, setAdding] = useState(false)
  const open = openFloors(floors, agents)
  const floor = currentFloor(open, saved)
  const lead = agents?.find(a => a.role === 'orchestrator' && a.floor === floor.key)
  const leadName = lead?.name || 'Orchestrator'
  const [messages, , error] = useData(agents && `/projects/${pid}/messages?floor=${floor.key}`, on(pid, 'message'))
  const [text, setText] = useState('')
  const [run, busy, sendError] = useAction()
  const [orchRun, setOrchRun] = useState(null)
  const [waiting, setWaiting] = useState(false)

  useEffect(() => { setOrchRun(running?.find(r => r.kind === 'orchestrator' && r.agent_id === lead?.id) || null); setWaiting(false) }, [running, lead?.id])
  useEvents(ev => {
    if (ev.project_id !== pid) return
    if (ev.type === 'run' && ev.data.kind === 'orchestrator' && ev.data.agent_id === lead?.id) {
      setOrchRun(ev.data.status === 'running' ? ev.data : null)
      if (ev.data.status !== 'running') setWaiting(false)
    }
    if (ev.type === 'message' && ev.data.role === 'orchestrator' && ev.data.floor === floor.key) setWaiting(false)
  })

  // Follow new messages only while the owner is at the bottom, so reading back is not interrupted.
  const atBottom = useRef(true)
  useEffect(() => {
    const f = () => { atBottom.current = innerHeight + scrollY >= document.documentElement.scrollHeight - 150 }
    addEventListener('scroll', f, { passive: true })
    return () => removeEventListener('scroll', f)
  }, [])
  const count = messages?.length
  useEffect(() => { if (count && atBottom.current) window.scrollTo(0, document.body.scrollHeight) }, [count])

  const send = e => {
    e?.preventDefault()
    const t = text.trim()
    if (!t) return
    atBottom.current = true
    run(async () => {
      await api(`/projects/${pid}/messages`, { method: 'POST', body: { text: t, floor: floor.key } })
      setText('')
      setWaiting(true)
    })
  }

  const thinking = orchRun || waiting
  return (
    <section className="chat" style={{ '--floor': floor.color }}>
      {open.length > 0 && (
        <div className="chat-floors">
          <FloorBar open={open} agents={agents} floor={floor.key} onPick={setFloor} onAdd={() => setAdding(true)} canAdd={open.length < (floors?.length || 0)} />
        </div>
      )}
      <ErrorText error={error} />
      {messages && messages.length === 0 && (
        <Empty>{floor.key === 'tech'
          ? `Give ${leadName} an order, for example: Add Google sign-in. It replies with a plan for you to approve.`
          : `Give ${leadName} an order for the ${floor.name} floor. ${floor.blurb} It replies with a plan for you to approve.`}</Empty>
      )}
      <ol className="messages">
        {messages?.map(m => (
          <li key={m.id} className={`msg ${m.role}`}>
            <div className="meta">{m.role === 'user' ? 'You' : m.role === 'system' ? 'Crew' : leadName} <span className="muted">{ago(m.created_at)}</span></div>
            {m.text && <div className="bubble"><Md text={m.text} /></div>}
            {m.order_id && <PlanCard orderId={m.order_id} pid={pid} agents={agents?.filter(a => a.floor === floor.key)} />}
          </li>
        ))}
      </ol>
      {thinking && (
        <p className="thinking" role="status">
          <span className="pulse" aria-hidden="true" /> {leadName} is thinking
          {orchRun?.last_event && <span className="muted mono"> {orchRun.last_event}</span>}
        </p>
      )}
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="order-text">Order or question for {leadName}</label>
        <textarea id="order-text" rows="2" placeholder={`Order or question for ${leadName} (Ctrl+Enter sends)`} value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() }} />
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>Send</Button>
      </form>
      <ErrorText error={sendError} />
      {adding && <OpenFloorSheet pid={pid} floors={floors} open={open} templates={templates}
        onOpened={k => { setAdding(false); setFloor(k) }} onClose={() => setAdding(false)} />}
    </section>
  )
}

function PlanCard({ orderId, pid, agents }) {
  const [order, reload, error] = useData(`/orders/${orderId}`,
    ev => ev.project_id === pid && ((ev.type === 'order' && ev.data.id === orderId) || (ev.type === 'task' && ev.data.order_id === orderId)))
  const [editing, setEditing] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [run, busy, actError] = useAction()

  if (error) return <ErrorText error={error} />
  if (!order) return <div className="card plan muted">Loading plan</div>
  const plan = order.plan || { tasks: [] }
  const tasks = order.tasks || []
  const byKey = Object.fromEntries(tasks.map(t => [t.plan_key, t]))
  const open = order.status === 'awaiting_approval'
  const done = tasks.filter(t => t.status === 'done').length

  const act = (path, body) => run(async () => {
    await api(`/orders/${orderId}/${path}`, { method: 'POST', body })
    setEditing(null)
    setFeedback('')
    reload()
  })
  const setField = (i, k, v) => setEditing(ts => ts.map((t, j) => (j === i ? { ...t, [k]: v } : t)))

  return (
    <article className="card plan" aria-label={`Plan for order ${orderId}`}>
      <header className="plan-head">
        <h3>{plan.summary || order.text}</h3>
        <Badge status={order.status} />
      </header>
      {tasks.length > 0 && (
        <p className="muted small">{done} of {tasks.length} tasks done. <a href={`#/board/${orderId}`}>Open on board</a></p>
      )}
      <ol className="plan-tasks">
        {(editing || plan.tasks || []).map((t, i) => editing ? (
          <li key={t.key} className="plan-task edit">
            <span className="key mono">{t.key}</span>
            <label className="field"><span>Title</span>
              <input value={t.title} onChange={e => setField(i, 'title', e.target.value)} />
            </label>
            <div className="row">
              <label className="field grow"><span>Agent</span>
                <input list={`agents-${orderId}`} value={t.agent ?? t.role ?? ''} onChange={e => setField(i, 'agent', e.target.value)} />
              </label>
              <label className="field"><span>Size</span>
                <select value={t.size} onChange={e => setField(i, 'size', e.target.value)}>
                  {['S', 'M', 'L'].map(s => <option key={s}>{s}</option>)}
                </select>
              </label>
            </div>
          </li>
        ) : (
          <li key={t.key} className="plan-task">
            <details>
              <summary>
                <span className="key mono">{t.key}</span>
                <span className="grow">{t.title}</span>
                <span className="pill">{t.agent || t.role}</span>
                <span className="pill">{t.size}</span>
                {byKey[t.key] && <Badge status={byKey[t.key].status} />}
              </summary>
              <div className="plan-detail">
                {t.depends_on?.length > 0 && <p className="small">After: <span className="mono">{t.depends_on.join(', ')}</span></p>}
                {t.description && <p>{t.description}</p>}
                {t.acceptance?.length > 0 && <ul className="checks">{t.acceptance.map((a, k) => <li key={k}>{a}</li>)}</ul>}
                {t.files?.length > 0 && <p className="small mono muted">{t.files.join('  ')}</p>}
              </div>
            </details>
          </li>
        ))}
      </ol>
      <datalist id={`agents-${orderId}`}>{agents?.filter(a => a.owned_paths?.length).map(a => <option key={a.id} value={a.name} />)}</datalist>
      {open && !editing && (
        <div className="actions">
          <Button variant="primary" disabled={busy} onClick={() => act('approve', {})}>Approve</Button>
          <Button disabled={busy} onClick={() => setEditing((plan.tasks || []).map(t => ({ ...t })))}>Edit</Button>
          <ConfirmButton variant="ghost" confirm="Reject plan" onConfirm={() => act('reject')} disabled={busy}>Reject</ConfirmButton>
        </div>
      )}
      {open && editing && (
        <div className="stack">
          <label className="field"><span>Feedback for the lead</span>
            <textarea rows="3" value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="For example: split t2, the backend should own the migration" />
          </label>
          <div className="actions">
            <Button variant="primary" disabled={busy} onClick={() => act('approve', { tasks: editing })}>Approve edited plan</Button>
            <Button disabled={busy || !feedback.trim()} onClick={() => act('revise', { feedback: feedback.trim() })}>Ask for a new plan</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {order.status === 'planning' && <p className="muted small">The lead is revising this plan.</p>}
      <ErrorText error={actError} />
    </article>
  )
}
