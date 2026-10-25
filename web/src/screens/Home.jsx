import { useEffect, useRef, useState } from 'react'
import { api, on, useData, useEvents } from '../api.js'
import { Badge, Button, ConfirmButton, Empty, ErrorText, More, Sheet, orderStatus, useAction } from '../ui.jsx'
import { Item, PushButton } from './Inbox.jsx'
import { Tile } from '../components/AgentTile.jsx'
import { PlanCard } from './Command.jsx'
import Office, { CrewThread, light } from '../components/Office.jsx'
import QuickTask from '../components/QuickTask.jsx'
import { FloorBar, OpenFloorSheet, currentFloor, openFloors } from '../components/Floors.jsx'
import Settings from '../components/Settings.jsx'
import { SupportThread, ServiceChips, ServicesSheetBody } from '../components/Support.jsx'
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

// Pane sizes in px, kept per browser: c1 config column, c3 terminal and orders column, r2 bottom row. Unset = default.
const PRESETS = [
  ['Focus', 'Terminal large', (w, h) => ({ c3: w * 0.68, r2: 140 })],
  ['Office', 'Agent space large', () => ({ c3: 360, r2: 150 })],
  ['Plan', 'Kanban and orders large', (w, h) => ({ c3: w * 0.4, r2: h * 0.55 })],
]
const PAD = 10

function useLayout(box) {
  const [lay, setLay] = useState(() => { try { return JSON.parse(localStorage.getItem('crew.layout')) || {} } catch { return {} } })
  // Same limits the drag sees, so the stored value never runs past what is drawn.
  const set = next => {
    const r = box.current.getBoundingClientRect()
    const l = { ...lay, ...next }
    for (const k in l) if (l[k] == null) delete l[k]
    if (l.c1) l.c1 = Math.round(Math.min(Math.max(l.c1, 140), 360))
    if (l.c3) l.c3 = Math.round(Math.min(Math.max(l.c3, 320), r.width - 4 * PAD - (l.c1 || 196) - 300))
    if (l.r2) l.r2 = Math.round(Math.min(Math.max(l.r2, 140), r.height - 3 * PAD - 200))
    setLay(l)
    try { localStorage.setItem('crew.layout', JSON.stringify(l)) } catch {}
  }
  const style = { '--c1': lay.c1 && `${lay.c1}px`, '--c3': lay.c3 && `${lay.c3}px`, '--r2': lay.r2 && `${lay.r2}px` }
  return [style, set]
}

// A drag handle sitting in the grid gap. Arrow keys nudge it, double click puts that edge back to default.
function Splitter({ k, box, set, label }) {
  const vertical = k !== 'r2'
  const size = (x, y) => {
    const r = box.current.getBoundingClientRect()
    return k === 'c1' ? x - r.left - PAD - PAD / 2 : k === 'c3' ? r.right - PAD - x - PAD / 2 : r.bottom - PAD - y - PAD / 2
  }
  const current = () => {
    const el = box.current.querySelector(k === 'c1' ? '.hq-config' : k === 'c3' ? '.hq-term' : '.hq-kanban').getBoundingClientRect()
    return k === 'r2' ? el.height : el.width
  }
  const down = e => {
    e.preventDefault()
    const h = e.currentTarget
    h.setPointerCapture(e.pointerId)
    const move = ev => set({ [k]: size(ev.clientX, ev.clientY) })
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up) }
    h.addEventListener('pointermove', move)
    h.addEventListener('pointerup', up)
  }
  // c1 grows rightward, c3 and r2 grow toward the top and left.
  const key = e => {
    const d = { ArrowLeft: -16, ArrowRight: 16, ArrowUp: -16, ArrowDown: 16 }[e.key]
    if (!d) return
    e.preventDefault()
    set({ [k]: current() + (k === 'c1' ? d : -d) })
  }
  return <div className={`splitter s-${k}`} role="separator" tabIndex={0} aria-orientation={vertical ? 'vertical' : 'horizontal'}
    aria-label={label} title={`${label}. Drag, or double click to reset`} onPointerDown={down} onKeyDown={key} onDoubleClick={() => set({ [k]: null })} />
}

// Home is one screen: the agent space with the selected agent's terminal beside it, and along the bottom
// config and vault, the kanban and the order section.
export default function Home({ pid, project, reloadProject, floors, floor: saved, setFloor }) {
  const wide = useWide()
  const [items] = useData(`/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))
  const [wall, , wallError] = useData(`/projects/${pid}/wall`, ev => ev.project_id === pid &&
    (['agent', 'order', 'task', 'crew_message'].includes(ev.type) || (ev.type === 'run' && ev.data.status !== 'running')))
  const [tasks] = useData(`/projects/${pid}/tasks`, on(pid, 'task'))
  const [services] = useData(`/projects/${pid}/services`, on(pid, 'service'))
  // Live run rows straight from run events, so a busy agent does not refetch the wall every second.
  const [live, setLive] = useState({})
  useEvents(ev => {
    if (ev.type === 'run' && ev.project_id === pid && ev.data.agent_id) setLive(l => ({ ...l, [ev.data.agent_id]: ev.data }))
  })
  const [selected, setSelected] = useState(null)
  const [sheet, setSheet] = useState(null)   // 'settings' | 'comms' | 'needs' | 'services' | 'floor'
  const [quick, setQuick] = useState(null)

  const everyone = (wall?.agents || []).map(a => {
    const l = live[a.id]
    // A newer run than the wall knows about wins; the wall refetch fills in its task title.
    const run = l && (!a.run || l.id >= a.run.id) ? { ...(a.run?.id === l.id ? a.run : {}), ...l } : a.run
    return { ...a, run }
  })
  const open = openFloors(floors, everyone)
  const floor = currentFloor(open, saved)
  const agents = everyone.filter(a => a.floor === floor.key)
  const orders = wall?.orders.filter(o => o.floor === floor.key)
  const [templates] = useData(sheet === 'floor' ? '/templates' : null)
  // Nothing picked: whoever is busy, else whoever ran last, so the pane does not jump away when a run ends.
  const latest = agents.filter(a => a.run).sort((x, y) => y.run.id - x.run.id)[0]
  const pick = agents.find(a => a.id === selected) || (wide ? agents.find(a => a.run?.status === 'running') || latest || agents[0] : null)
  const pane = pick && <Tile a={pick} expanded onQuick={() => setQuick(pick.name)} />
  const close = () => setSheet(null)
  const box = useRef()
  const [layStyle, setLay] = useLayout(box)
  const preset = f => { const r = box.current.getBoundingClientRect(); setLay({ c1: null, c3: null, r2: null, ...f(r.width, r.height) }) }

  return (
    <section className={`hq ${items?.length ? 'has-needs' : ''}`} ref={box} style={wide ? layStyle : undefined}>
      <section className="hq-space" aria-label="Agent space">
        <ErrorText error={wallError} />
        {!wide && items?.length > 0 && <NeedsStrip items={items} onOpen={() => setSheet('needs')} />}
        {wall && <FloorBar open={open} agents={everyone} floor={floor.key} onPick={k => { setFloor(k); setSelected(null) }}
          onAdd={() => setSheet('floor')} canAdd={open.length < (floors?.length || 0)} />}
        {wall && <Office pid={pid} agents={agents} crew={wall.crew} selected={pick?.id} onSelect={setSelected} floor={floor}
          inboxCount={items?.length || 0} onComms={() => setSheet('comms')} services={services} onServices={() => setSheet('services')} />}
      </section>

      {wide && (
        <section className="hq-term" aria-label="Terminal">
          <div className="term-strip">
            <div className="strip-tabs" role="group" aria-label="Agents">
              {agents.map(a => {
                const lt = light(a)
                return (
                  <button key={a.id} type="button" aria-pressed={pick?.id === a.id} className={`strip-tab l-${lt}`}
                    onClick={() => setSelected(a.id)} title={lt === 'ask' ? `${a.name} is waiting for your answer` : a.name}>
                    <i className="light" aria-hidden="true" />{a.name}
                  </button>
                )
              })}
            </div>
            <More label="Layout">
              {PRESETS.map(([name, title, f]) => <Button key={name} variant="ghost" onClick={() => preset(f)}>{name}: {title.toLowerCase()}</Button>)}
              <Button variant="ghost" onClick={() => setLay({ c1: null, c3: null, r2: null })}>Default layout</Button>
            </More>
          </div>
          {pane || <Empty>No agents yet.</Empty>}
        </section>
      )}
      {wide && <>
        <Splitter k="c3" box={box} set={setLay} label="Resize terminal" />
        <Splitter k="r2" box={box} set={setLay} label="Resize bottom row" />
        <Splitter k="c1" box={box} set={setLay} label="Resize config column" />
      </>}

      <nav className="hq-config" aria-label="Config and vault">
        <Tool label="Settings" d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4" onClick={() => setSheet('settings')} />
        <Tool label="Vault" d="M4 5h16v14H4zM4 9h16M10 13h4" href="#/vault" />
        <Tool label="Team" d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 1 0 0-5M17 14c2.3.4 4 2.6 4 6" href="#/team" />
        <Tool label="Projects" d="M3 7h7l2 2h9v10H3z" href="#/projects" />
      </nav>

      <section className="hq-kanban" aria-label="Kanban">
        <Kanban tasks={tasks} orders={orders} />
      </section>

      <section className="hq-orders" aria-label="Orders">
        <Orders pid={pid} floor={floor} agents={agents} lead={agents.find(a => a.role === 'orchestrator')} orders={orders} needs={items?.length || 0} onNeeds={() => setSheet('needs')}
          support={agents.find(a => a.role === 'support')} services={services} onServices={() => setSheet('services')} />
      </section>

      {!wide && pick && <Sheet title={pick.name} onClose={() => setSelected(null)}>{pane}</Sheet>}
      {sheet === 'settings' && project && <Settings project={project} reload={reloadProject} onClose={close} />}
      {sheet === 'services' && <Sheet title="Services" onClose={close}><ServicesSheetBody pid={pid} /></Sheet>}
      {sheet === 'floor' && <OpenFloorSheet pid={pid} floors={floors} open={open} templates={templates}
        onOpened={k => { close(); setFloor(k) }} onClose={close} />}
      {sheet === 'comms' && <Sheet title="Crew comms" onClose={close}><CrewThread crew={wall?.crew} /></Sheet>}
      {sheet === 'needs' && (
        <Sheet title="Needs you" onClose={close}>
          <div className="stack">
            <div className="row"><span className="grow" /><PushButton /></div>
            {items?.length ? <ul className="list">{items.map(i => <Item key={i.id} i={i} />)}</ul> : <Empty>All clear. Nothing needs you right now.</Empty>}
            <a className="small" href="#/inbox" onClick={close}>Open Needs you</a>
          </div>
        </Sheet>
      )}
      {quick && <QuickTask pid={pid} agent={quick} onClose={() => setQuick(null)} />}
    </section>
  )
}

const ACT = { plan: 'Review plan', merge: 'Review merge', permission: 'Answer', question: 'Answer', failure: 'See failure' }

// Phones: what needs the owner sits above the room instead of a scroll away.
function NeedsStrip({ items, onOpen }) {
  const first = items[0]
  return (
    <div className="needs-strip" role="status">
      <span className="count">{items.length}</span>
      <span className="clip grow">{first.title}</span>
      <Button small variant="primary" onClick={onOpen}>{items.length > 1 ? 'Open all' : ACT[first.kind] || 'Open'}</Button>
    </div>
  )
}

const Glyph = ({ d }) => <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d={d} /></svg>

function Tool({ label, d, href, onClick }) {
  return href
    ? <a className="tool" href={href}><Glyph d={d} /><span>{label}</span></a>
    : <button type="button" className="tool" onClick={onClick}><Glyph d={d} /><span>{label}</span></button>
}

// Work in flight only: tasks of this floor's open orders.
function Kanban({ tasks, orders }) {
  if (!tasks || !orders) return null
  const open = new Set(orders.map(o => o.id))
  const shown = tasks.filter(t => open.has(t.order_id))
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

// The order section has two modes: orders for the build team, and Support for chores (no plan, no PR).
function Orders({ pid, floor, agents, lead, orders, needs, onNeeds, support, services, onServices }) {
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('crew.bar') === 'support' ? 'support' : 'order' } catch { return 'order' } })
  const pickMode = m => { setMode(m); setSent(false); try { localStorage.setItem('crew.bar', m) } catch {} }
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [run, busy, error] = useAction()
  const send = e => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    run(async () => {
      if (mode === 'support') await api(`/projects/${pid}/support`, { method: 'POST', body: { text: t } })
      else { await api(`/projects/${pid}/messages`, { method: 'POST', body: { text: t, floor: floor.key } }); setSent(true) }
      setText('')
    })
  }
  const cancel = id => run(() => api(`/orders/${id}/cancel`, { method: 'POST' }))
  return (
    <>
      <div className="orders-head">
        <div className="mode" role="group" aria-label="Who gets your message">
          <button type="button" aria-pressed={mode === 'order'} onClick={() => pickMode('order')}>Orders</button>
          <button type="button" aria-pressed={mode === 'support'} onClick={() => pickMode('support')}>Support</button>
        </div>
        <span className="grow" />
        <button type="button" className={`needs-btn ${needs ? '' : 'calm'}`} onClick={onNeeds}>{needs ? `${needs} need${needs === 1 ? 's' : ''} you` : 'All clear'}</button>
      </div>
      {mode === 'support' ? (
        <>
          <SupportThread pid={pid} support={support} floor={floor.key} onSentToTeam={() => { pickMode('order'); setSent(true) }} />
          <ServiceChips services={services} onOpen={onServices} />
        </>
      ) : (
        <ul className="order-list">
          {orders?.length ? orders.map(o => {
            const total = Object.values(o.counts).reduce((s, n) => s + n, 0)
            const done = o.counts.done || 0
            return (
              <li key={o.id} className="order-line">
                <a className="clip" href={`#/board/${o.id}`}>{o.plan?.summary || o.text}</a>
                {o.status === 'awaiting_approval' ? <Badge status="plan">Plan ready</Badge> : total > 0
                  ? <span className="progress" title={`${done} of ${total} tasks done, $${Number(o.cost_usd || 0).toFixed(2)} so far`}><span style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
                  : <Badge status={orderStatus(o)} />}
                <More label={`Actions for ${o.plan?.summary || o.text}`}>
                  <a className="btn ghost" href={`#/board/${o.id}`}>Open on the board</a>
                  <ConfirmButton variant="ghost" confirm="Stop its tasks and cancel" disabled={busy} onConfirm={() => cancel(o.id)}>Cancel order</ConfirmButton>
                </More>
                {o.status === 'awaiting_approval' && <PlanCard orderId={o.id} pid={pid} agents={agents} />}
              </li>
            )
          }) : <li className="lane-empty">No open orders</li>}
        </ul>
      )}
      <form className={`order-bar ${mode}`} onSubmit={send}>
        <label className="sr-only" htmlFor="hq-order">{mode === 'support' ? 'Ask Support' : `New order for ${lead?.name || 'the lead'}`}</label>
        <input id="hq-order" value={text} onChange={e => { setText(e.target.value); setSent(false) }}
          placeholder={mode === 'support' ? 'Ask Support: start the server, run the tests, query the db...' : `Give the ${floor.name} floor an order...`} />
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>{mode === 'support' ? 'Ask' : 'Send'}</Button>
      </form>
      {sent && mode === 'order' && <p className="small muted">Sent. The plan shows up here when the lead has it, and on <a href="#/command">Command</a>.</p>}
      <ErrorText error={error} />
    </>
  )
}
