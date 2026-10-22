import { useEffect, useState } from 'react'
import { on, useData, useEvents } from '../api.js'
import { Badge, Empty, ErrorText, Sheet } from '../ui.jsx'
import { Item, PushButton } from './Inbox.jsx'
import { Tile } from './Wall.jsx'
import Office from '../components/Office.jsx'
import QuickTask from '../components/QuickTask.jsx'
import '../office.css'

const KANBAN = [['planned', 'Planned'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['qa', 'QA'], ['blocked', 'Blocked'], ['done', 'Done']]

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

// The office: config rail, agent space with comms, the selected agent's terminal, a kanban strip, orders and what needs the owner.
export default function Home({ pid }) {
  const wide = useWide()
  const [items, , error] = useData(`/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))
  const [wall, , wallError] = useData(`/projects/${pid}/wall`, ev => ev.project_id === pid &&
    (['agent', 'order', 'task', 'crew_message'].includes(ev.type) || (ev.type === 'run' && ev.data.status !== 'running')))
  const [tasks] = useData(`/projects/${pid}/tasks`, on(pid, 'task'))
  // Live run rows straight from run events, so a busy agent does not refetch the wall every second.
  const [live, setLive] = useState({})
  useEvents(ev => {
    if (ev.type === 'run' && ev.project_id === pid && ev.data.agent_id) setLive(l => ({ ...l, [ev.data.agent_id]: ev.data }))
  })
  const [selected, setSelected] = useState(null)
  const [quick, setQuick] = useState(null)

  const agents = (wall?.agents || []).map(a => {
    const l = live[a.id]
    // A newer run than the wall knows about wins; the wall refetch fills in its task title.
    const run = l && (!a.run || l.id >= a.run.id) ? { ...(a.run?.id === l.id ? a.run : {}), ...l } : a.run
    return { ...a, run }
  })
  // Desktop always shows a terminal: the picked agent, else whoever is busy.
  const pick = agents.find(a => a.id === selected) || (wide ? agents.find(a => a.run?.status === 'running') || agents[0] : null)

  const needs = (
    <section className="card stack" aria-labelledby="needs-you">
      <div className="row wrap">
        <h2 id="needs-you" className="grow">Needs you {items?.length > 0 && <span className="count">{items.length}</span>}</h2>
        <PushButton />
      </div>
      <ErrorText error={error} />
      {items?.length === 0 && <Empty>All clear. Nothing needs you right now.</Empty>}
      <ul className="list">{items?.map(i => <Item key={i.id} i={i} />)}</ul>
      <a className="small" href="#/inbox">Inbox history</a>
    </section>
  )

  const orders = wall && (
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
  )

  const pane = pick && <Tile a={pick.run ? pick : { ...pick, run: null }} expanded onQuick={() => setQuick(pick.name)} />

  return (
    <section className="office-home">
      <nav className="office-rail" aria-label="Crew setup">
        <a className="rail-btn" href="#/vault" title="Shared context vault: notes, decisions, files agents can pull"><Glyph d="M4 5h16v14H4zM4 9h16M9 13h6" /><span>Vault</span></a>
        <a className="rail-btn" href="#/team" title="Team: add, clone and configure agents"><Glyph d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 1 0 0-5M17 14c2.3.4 4 2.6 4 6" /><span>Team</span></a>
        <a className="rail-btn" href="#/board" title="Board"><Glyph d="M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z" /><span>Board</span></a>
        <a className="rail-btn" href="#/projects" title="Projects"><Glyph d="M3 7h7l2 2h9v10H3z" /><span>Projects</span></a>
      </nav>

      <section className="card office-space" aria-label="Agent space">
        <div className="row"><h2 className="grow">Agent space</h2><span className="muted small">Tap a desk to see its terminal</span></div>
        <ErrorText error={wallError} />
        {wall && <Office pid={pid} agents={agents} crew={wall.crew} selected={pick?.id} onSelect={setSelected} inboxCount={items?.length || 0} />}
      </section>

      {wide && <section className="office-term" aria-label="Terminal">{pane || <div className="card"><Empty>No agents yet.</Empty></div>}</section>}

      <section className="card office-kanban" aria-label="Kanban">
        <div className="row"><h2 className="grow">Kanban</h2><a className="small" href="#/board">Open board</a></div>
        <Kanban tasks={tasks} orders={wall?.orders} />
      </section>

      <div className="office-orders">{needs}{orders}</div>

      {!wide && pick && (
        <Sheet title={pick.name} onClose={() => setSelected(null)}>{pane}</Sheet>
      )}
      {quick && <QuickTask pid={pid} agent={quick} onClose={() => setQuick(null)} />}
    </section>
  )
}

const Glyph = ({ d }) => <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d={d} /></svg>

// Work in flight only: tasks of open orders, plus anything blocked.
function Kanban({ tasks, orders }) {
  if (!tasks || !orders) return null
  const open = new Set(orders.map(o => o.id))
  const shown = tasks.filter(t => open.has(t.order_id) || t.status === 'blocked')
  if (!shown.length) return <Empty>Nothing in flight.</Empty>
  return (
    <div className="kanban-strip">
      {KANBAN.map(([id, name]) => {
        const list = shown.filter(t => t.status === id)
        return (
          <a key={id} className={`kcol s-${id}`} href="#/board">
            <span className="kcol-head"><span>{name}</span><span className="n">{list.length}</span></span>
            {list.slice(0, 3).map(t => <span key={t.id} className="kcard clip">{t.title}</span>)}
            {list.length > 3 && <span className="muted small">+{list.length - 3} more</span>}
          </a>
        )
      })}
    </div>
  )
}
