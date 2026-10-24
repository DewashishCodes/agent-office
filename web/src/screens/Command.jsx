import { useEffect, useRef, useState } from 'react'
import { api, on, useData, useEvents } from '../api.js'
import { Ago, Badge, Button, ConfirmButton, Empty, ErrorText, Sheet, orderStatus, taskStatus, tokens, useAction } from '../ui.jsx'
import { Md } from '../components/Transcript.jsx'
import Working from '../components/Working.jsx'
import { FloorBar, OpenFloorSheet, currentFloor, openFloors } from '../components/Floors.jsx'

// The open chat per project and floor. Kept across screens but not across reloads, so every visit starts a new chat.
const openChat = {}
// Phones keep Enter for new lines; the Send button sends.
const enterSends = !matchMedia('(pointer: coarse)').matches

export default function Command({ pid, running, floors, floor: saved, setFloor }) {
  const [agents] = useData(`/projects/${pid}/agents`, on(pid, 'agent'))
  const [templates] = useData('/templates')
  const [adding, setAdding] = useState(false)
  const open = openFloors(floors, agents)
  const floor = currentFloor(open, saved)
  const lead = agents?.find(a => a.role === 'orchestrator' && a.floor === floor.key)
  const leadName = lead?.name || 'Orchestrator'
  const slot = `${pid}:${floor.key}`
  const [chatId, setChatState] = useState(openChat[slot] ?? null)
  useEffect(() => setChatState(openChat[slot] ?? null), [slot])
  const [listOpen, setListOpen] = useState(false)
  const [hotfix, setHotfix] = useState(false)
  const pick = id => { openChat[slot] = id; setChatState(id); setListOpen(false); atBottom.current = true }
  const [chats] = useData(agents && `/projects/${pid}/chats?floor=${floor.key}`, on(pid, 'chat', 'message'))
  const [loaded, , error] = useData(chatId && `/projects/${pid}/messages?chat=${chatId}`, on(pid, 'message'))
  const messages = chatId ? loaded : []
  const title = chats?.find(c => c.id === chatId)?.title || 'New chat'
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
      const r = await api(`/projects/${pid}/messages`, { method: 'POST', body: { text: t, floor: floor.key, chat_id: chatId, hotfix } })
      if (!chatId && r?.chat_id) pick(r.chat_id)
      setText('')
      setHotfix(false)
      setWaiting(true)
    })
  }

  const thinking = orchRun || waiting
  const list = <ChatList chats={chats} current={chatId} onPick={pick} />
  return (
    <div className="chat-shell">
      <aside className="chat-side">{list}</aside>
    <section className="chat" style={{ '--floor': floor.color }}>
      {open.length > 0 && (
        <div className="chat-floors">
          <FloorBar open={open} agents={agents} floor={floor.key} onPick={setFloor} onAdd={() => setAdding(true)} canAdd={open.length < (floors?.length || 0)} />
        </div>
      )}
      <div className="chat-head">
        <Button small variant="ghost" className="chats-btn" onClick={() => setListOpen(true)}>Chats</Button>
        <h1 className="grow clip">{title}</h1>
        {chatId && <Button small onClick={() => pick(null)}>New chat</Button>}
      </div>
      <ErrorText error={error} />
      {messages && messages.length === 0 && (
        <div className="chat-empty">
          <h2>What should {leadName} work on?</h2>
          <p className="muted">{floor.key === 'tech'
            ? 'Give an order, for example: Add Google sign-in. You get a plan to approve before anyone starts.'
            : `Give an order for the ${floor.name} floor. ${floor.blurb} You get a plan to approve before anyone starts.`}</p>
        </div>
      )}
      <ol className="messages">
        {messages?.map(m => (
          <li key={m.id} className={`msg ${m.role}`}>
            <div className="meta">{m.role === 'user' ? 'You' : m.role === 'system' ? 'Crew' : leadName} <span className="muted"><Ago at={m.created_at} /></span></div>
            {m.text && <div className="bubble"><Md text={m.text} /></div>}
            {m.order_id && <PlanCard orderId={m.order_id} pid={pid} agents={agents?.filter(a => a.floor === floor.key)} />}
          </li>
        ))}
      </ol>
      {thinking && <Working text={`${leadName} is thinking`} lastEvent={orchRun?.last_event} since={orchRun?.started_at} />}
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="order-text">Order or question for {leadName}</label>
        <textarea id="order-text" rows="2" placeholder={`Message ${leadName}${enterSends ? ' (Enter sends, Shift+Enter for a new line)' : ''}`} value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (enterSends && !e.shiftKey && !e.nativeEvent.isComposing))) { e.preventDefault(); send() } }} />
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>Send</Button>
      </form>
      {floor.key === 'tech' && (
        <label className={`check small hotfix-toggle ${hotfix ? 'warn' : 'muted'}`}>
          <input type="checkbox" checked={hotfix} onChange={e => setHotfix(e.target.checked)} />
          {hotfix ? 'Hotfix: after you approve the plan, tasks push straight to the project branch. No PR, Reviewer or QA.' : 'Hotfix'}
        </label>
      )}
      <ErrorText error={sendError} />
      {listOpen && <Sheet title="Chats" onClose={() => setListOpen(false)}>{list}</Sheet>}
      {adding && <OpenFloorSheet pid={pid} floors={floors} open={open} templates={templates}
        onOpened={k => { setAdding(false); setFloor(k) }} onClose={() => setAdding(false)} />}
    </section>
    </div>
  )
}

function ChatList({ chats, current, onPick }) {
  return (
    <nav className="chat-list" aria-label="Chats">
      <Button variant="primary" onClick={() => onPick(null)}>New chat</Button>
      {chats?.length ? (
        <ul>
          {chats.map(c => (
            <li key={c.id}>
              <button type="button" aria-current={c.id === current || undefined} onClick={() => onPick(c.id)}>
                <span className="clip">{c.title}</span>
                <span className="muted small"><Ago at={c.updated_at} /></span>
              </button>
            </li>
          ))}
        </ul>
      ) : chats && <p className="muted small">No chats yet</p>}
    </nav>
  )
}

export function PlanCard({ orderId, pid, agents }) {
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
  const est = order.estimates, guessOf = t => est?.[t.size] || est?.M
  const total = est && (plan.tasks || []).reduce((s, t) => ({ cost: s.cost + guessOf(t).cost, tokens: s.tokens + guessOf(t).tokens }), { cost: 0, tokens: 0 })
  const history = est && Object.values(est).some(e => e.n)

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
        {order.hotfix ? <span className="pill warn" title="Pushes straight to the project branch, no PR, review or QA">Hotfix</span> : null}
        <Badge status={orderStatus(order)} />
      </header>
      {tasks.length > 0 && (
        <p className="muted small">{done} of {tasks.length} tasks done, ${Number(order.cost_usd || 0).toFixed(2)} so far. <a href={`#/board/${orderId}`}>Open on board</a></p>
      )}
      {open && total && (
        <p className="small">About ${total.cost.toFixed(2)} and {tokens(total.tokens)} tokens <span className="muted">({history ? 'from this project\'s finished tasks' : 'a rough guess until tasks finish here'})</span></p>
      )}
      {open && plan.tasks?.length > 1 && <p className="muted small">{shape(plan.tasks)}</p>}
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
                {open && est && <span className="muted small" title={`${tokens(guessOf(t).tokens)} tokens`}>~${guessOf(t).cost.toFixed(2)}</span>}
                {byKey[t.key] && <Badge status={taskStatus(byKey[t.key])} />}
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

// How parallel a plan is: tasks in the same wave have no dependency between them and can run at once.
function shape(tasks) {
  const keys = new Set(tasks.map(t => t.key))
  const wave = {}
  const level = (t, seen = new Set()) => {
    if (wave[t.key] != null) return wave[t.key]
    if (seen.has(t.key)) return 0
    seen.add(t.key)
    const deps = (t.depends_on || []).filter(k => keys.has(k)).map(k => level(tasks.find(x => x.key === k), seen))
    return (wave[t.key] = deps.length ? Math.max(...deps) + 1 : 0)
  }
  tasks.forEach(t => level(t))
  const waves = Math.max(...Object.values(wave)) + 1
  const widest = Math.max(...Object.values(Object.groupBy(tasks, t => wave[t.key])).map(w => w.length))
  const agents = new Set(tasks.map(t => t.agent || t.role)).size
  return `${tasks.length} tasks for ${agents} agent${agents === 1 ? '' : 's'}, in ${waves} step${waves === 1 ? '' : 's'}: at most ${widest} at once.${waves === tasks.length ? ' Fully chained, so nothing runs in parallel.' : ''}`
}
