import { useEffect, useState } from 'react'
import { api, on, useData, useEvents } from '../api.js'
import { Badge, Button, ConfirmButton, Empty, ErrorText, More, Sheet, useAction } from '../ui.jsx'
import { Item, PushButton } from './Inbox.jsx'
import { Tile } from './Wall.jsx'
import Office, { CrewThread } from '../components/Office.jsx'
import QuickTask from '../components/QuickTask.jsx'
import Settings from '../components/Settings.jsx'
import '../office.css'

// Three boxes, as sketched: waiting, being built, being checked. Done is a count in the header.
const LANES = [['todo', 'To do', ['planned', 'blocked']], ['doing', 'Doing', ['in_progress']], ['check', 'Review & QA', ['in_review', 'qa']]]

function useWide() {
  const q = '(min-width: 900px)'
  const [wide, setWide] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q), f = () => setWide(m.matches)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])
  return wide
}

// Home is one screen: the agent space with the selected agent's terminal beside it, and along the bottom
// config and vault, the kanban and the order section.
export default function Home({ pid, project, reloadProject }) {
  const wide = useWide()
  const [items] = useData(`/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))
  const [wall, , wallError] = useData(`/projects/${pid}/wall`, ev => ev.project_id === pid &&
    (['agent', 'order', 'task', 'crew_message'].includes(ev.type) || (ev.type === 'run' && ev.data.status !== 'running')))
  const [tasks] = useData(`/projects/${pid}/tasks`, on(pid, 'task'))
  // Live run rows straight from run events, so a busy agent does not refetch the wall every second.
  const [live, setLive] = useState({})
  useEvents(ev => {
    if (ev.type === 'run' && ev.project_id === pid && ev.data.agent_id) setLive(l => ({ ...l, [ev.data.agent_id]: ev.data }))
  })
  const [selected, setSelected] = useState(null)
  const [sheet, setSheet] = useState(null)   // 'settings' | 'comms' | 'needs'
  const [quick, setQuick] = useState(null)

  const agents = (wall?.agents || []).map(a => {
    const l = live[a.id]
    // A newer run than the wall knows about wins; the wall refetch fills in its task title.
    const run = l && (!a.run || l.id >= a.run.id) ? { ...(a.run?.id === l.id ? a.run : {}), ...l } : a.run
    return { ...a, run }
  })
  // Desktop always shows a terminal: the picked agent, else whoever is busy.
  const pick = agents.find(a => a.id === selected) || (wide ? agents.find(a => a.run?.status === 'running') || agents[0] : null)
  const pane = pick && <Tile a={pick} expanded onQuick={() => setQuick(pick.name)} />
  const close = () => setSheet(null)

  return (
    <section className="hq">
      <section className="hq-space" aria-label="Agent space">
        <ErrorText error={wallError} />
        {wall && <Office pid={pid} agents={agents} crew={wall.crew} selected={pick?.id} onSelect={setSelected}
          inboxCount={items?.length || 0} onComms={() => setSheet('comms')} />}
      </section>

      {wide && <section className="hq-term" aria-label="Terminal">{pane || <Empty>No agents yet.</Empty>}</section>}

      <nav className="hq-config" aria-label="Config and vault">
        <Tool label="Settings" d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4" onClick={() => setSheet('settings')} />
        <Tool label="Vault" d="M4 5h16v14H4zM4 9h16M10 13h4" href="#/vault" />
        <Tool label="Team" d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 1 0 0-5M17 14c2.3.4 4 2.6 4 6" href="#/team" />
        <Tool label="Projects" d="M3 7h7l2 2h9v10H3z" href="#/projects" />
      </nav>

      <section className="hq-kanban" aria-label="Kanban">
        <Kanban tasks={tasks} orders={wall?.orders} />
      </section>

      <section className="hq-orders" aria-label="Orders">
        <Orders pid={pid} orders={wall?.orders} needs={items?.length || 0} onNeeds={() => setSheet('needs')} />
      </section>

      {!wide && pick && <Sheet title={pick.name} onClose={() => setSelected(null)}>{pane}</Sheet>}
      {sheet === 'settings' && project && <Settings project={project} reload={reloadProject} onClose={close} />}
      {sheet === 'comms' && <Sheet title="Crew comms" onClose={close}><CrewThread crew={wall?.crew} /></Sheet>}
      {sheet === 'needs' && (
        <Sheet title="Needs you" onClose={close}>
          <div className="stack">
            <div className="row"><span className="grow" /><PushButton /></div>
            {items?.length ? <ul className="list">{items.map(i => <Item key={i.id} i={i} />)}</ul> : <Empty>All clear. Nothing needs you right now.</Empty>}
            <a className="small" href="#/inbox" onClick={close}>Inbox history</a>
          </div>
        </Sheet>
      )}
      {quick && <QuickTask pid={pid} agent={quick} onClose={() => setQuick(null)} />}
    </section>
  )
}

const Glyph = ({ d }) => <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d={d} /></svg>

function Tool({ label, d, href, onClick }) {
  return href
    ? <a className="tool" href={href}><Glyph d={d} /><span>{label}</span></a>
    : <button type="button" className="tool" onClick={onClick}><Glyph d={d} /><span>{label}</span></button>
}

// Work in flight only: tasks of open orders, plus anything blocked.
function Kanban({ tasks, orders }) {
  if (!tasks || !orders) return null
  const open = new Set(orders.map(o => o.id))
  const shown = tasks.filter(t => open.has(t.order_id) || t.status === 'blocked')
  const done = shown.filter(t => t.status === 'done').length
  return LANES.map(([id, name, statuses], i) => {
    const list = shown.filter(t => statuses.includes(t.status))
    return (
      <a key={id} className={`lane l-${id}`} href="#/board">
        <span className="lane-head"><span>{name}</span><span className="n">{list.length}</span></span>
        <span className="lane-cards">
          {list.length ? list.map(t => (
            <span key={t.id} className={`kcard ${t.status === 'blocked' ? 'blocked' : ''}`}>
              <span className="clip">{t.title}</span>
              <span className="kmeta">{t.agent_name || t.role}{t.status === 'blocked' ? ', blocked' : t.status === 'qa' ? ', QA' : ''}</span>
            </span>
          )) : <span className="lane-empty">Nothing</span>}
        </span>
        {i === 2 && done > 0 && <span className="lane-done">{done} done, waiting for merge</span>}
      </a>
    )
  })
}

function Orders({ pid, orders, needs, onNeeds }) {
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [run, busy, error] = useAction()
  const send = e => {
    e.preventDefault()
    const t = text.trim()
    if (t) run(async () => { await api(`/projects/${pid}/messages`, { method: 'POST', body: { text: t } }); setText(''); setSent(true) })
  }
  const approve = id => run(() => api(`/orders/${id}/approve`, { method: 'POST', body: {} }))
  const cancel = id => run(() => api(`/orders/${id}/cancel`, { method: 'POST' }))
  return (
    <>
      <div className="orders-head">
        <h2>Orders</h2>
        <button type="button" className={`needs-btn ${needs ? '' : 'calm'}`} onClick={onNeeds}>{needs ? `${needs} need${needs === 1 ? 's' : ''} you` : 'All clear'}</button>
      </div>
      <ul className="order-list">
        {orders?.length ? orders.map(o => {
          const total = Object.values(o.counts).reduce((s, n) => s + n, 0)
          const done = o.counts.done || 0
          return (
            <li key={o.id} className="order-line">
              <a className="clip" href={`#/board/${o.id}`}>{o.plan?.summary || o.text}</a>
              {o.status === 'awaiting_approval' ? (
                <span className="row">
                  <a className="small" href="#/command">Plan</a>
                  <Button small variant="primary" disabled={busy} onClick={() => approve(o.id)}>Approve</Button>
                </span>
              ) : total > 0
                ? <span className="progress" title={`${done} of ${total} tasks done`}><span style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
                : <Badge status={o.status} />}
              <More label={`Actions for ${o.plan?.summary || o.text}`}>
                <a className="btn ghost" href={`#/board/${o.id}`}>Open on the board</a>
                <ConfirmButton variant="ghost" confirm="Stop its tasks and cancel" disabled={busy} onConfirm={() => cancel(o.id)}>Cancel order</ConfirmButton>
              </More>
            </li>
          )
        }) : <li className="lane-empty">No open orders</li>}
      </ul>
      <form className="order-bar" onSubmit={send}>
        <label className="sr-only" htmlFor="hq-order">New order for the Orchestrator</label>
        <input id="hq-order" value={text} onChange={e => { setText(e.target.value); setSent(false) }} placeholder="Give the crew an order..." />
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>Send</Button>
      </form>
      {sent && <p className="small muted">Sent. The plan comes back on <a href="#/command">Command</a>.</p>}
      <ErrorText error={error} />
    </>
  )
}
