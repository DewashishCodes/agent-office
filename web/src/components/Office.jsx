import { useLayoutEffect, useRef, useState } from 'react'
import { useEvents } from '../api.js'
import { Badge, ago, initials } from '../ui.jsx'
import { clawdFor, clawdUrl } from '../clawd.js'

const FLIGHT_MS = 1100
const BUBBLE_MS = 9000
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// Stable hue per agent so a name has the same colour on the floor and in the thread.
export const hue = id => (id == null ? 28 : (id * 67) % 360)

// The office floor: one desk per agent, a mail tray for the owner, notes flying between them as agents message each other.
// agents: wall agents with their newest run in a.run. onSelect(agent_id) opens that agent's terminal.
export default function Office({ pid, agents, crew, selected, onSelect, inboxCount = 0 }) {
  const floor = useRef()
  const [flights, setFlights] = useState([])
  const [bubbles, setBubbles] = useState({})
  // Short animation overrides while a note leaves or lands: { agent_id: set }.
  const [moments, setMoments] = useState({})

  const moment = (id, set, ms) => {
    setMoments(m => ({ ...m, [id]: set }))
    setTimeout(() => setMoments(m => { const n = { ...m }; if (n[id] === set) delete n[id]; return n }), ms)
  }
  const bubble = (key, b) => {
    setBubbles(x => ({ ...x, [key]: b }))
    setTimeout(() => setBubbles(x => { const n = { ...x }; if (n[key] === b) delete n[key]; return n }), BUBBLE_MS)
  }

  useEvents(ev => {
    if (ev.type !== 'crew_message' || ev.project_id !== pid) return
    const m = ev.data
    const from = m.from_agent_id ?? 'owner'
    const targets = m.to_owner ? ['owner'] : m.to_agent_id ? [m.to_agent_id] : agents.map(a => a.id).filter(id => id !== m.from_agent_id)
    const b = { from: m.from_name || 'You', text: m.text, kind: m.kind }
    if (m.from_agent_id) moment(m.from_agent_id, m.kind === 'question' ? 'ask' : 'new-mail', 4000)
    const land = () => targets.forEach(t => {
      bubble(t, b)
      if (t !== 'owner') moment(t, 'read-note', 5000)
    })
    const box = floor.current
    if (!box || still()) return land()
    const at = key => {
      const el = box.querySelector(`[data-desk="${key}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect(), f = box.getBoundingClientRect()
      return { x: r.left - f.left + r.width / 2, y: r.top - f.top + r.height / 3 }
    }
    const a = at(from)
    const fl = targets.map(t => ({ id: `${m.id}-${t}`, a, b: at(t) })).filter(x => x.a && x.b)
    setFlights(f => [...f, ...fl])
    setTimeout(() => { setFlights(f => f.filter(x => !fl.includes(x))); land() }, FLIGHT_MS)
  })

  return (
    <div className="floor" ref={floor}>
      <ul className="desks">
        {agents.map(a => (
          <Desk key={a.id} a={a} set={moments[a.id] || clawdFor(a, a.run)} bubble={bubbles[a.id]} selected={selected === a.id} onSelect={() => onSelect(a.id)} />
        ))}
        <li className="desk owner-desk" data-desk="owner">
          <span className="tray" aria-hidden="true"><span /><span /><span /></span>
          <span className="plate"><span className="title">You</span>{inboxCount > 0 && <span className="count">{inboxCount}</span>}</span>
          <span className="muted small">{inboxCount ? 'Things need you' : 'Mail tray'}</span>
          {bubbles.owner && <Bubble b={bubbles.owner} />}
        </li>
      </ul>
      {flights.map(f => (
        <span key={f.id} className="note-flight" aria-hidden="true"
          style={{ left: f.a.x, top: f.a.y, '--dx': `${f.b.x - f.a.x}px`, '--dy': `${f.b.y - f.a.y}px`, animationDuration: `${FLIGHT_MS}ms` }} />
      ))}
      <div className="comms-head">
        <img className="clawd sm" src={clawdUrl('pass-note')} alt="" width="96" height="32" draggable="false" />
        <h3>Crew comms</h3>
      </div>
      <CrewThread crew={crew} />
    </div>
  )
}

function Desk({ a, set, bubble, selected, onSelect }) {
  const r = a.run
  const working = r?.status === 'running'
  const line = working ? (r.last_event || r.task_title || 'Starting') : a.status === 'paused' ? 'Paused' : r ? `Last: ${r.task_title || r.kind}` : a.role
  const state = working ? r.state : a.status === 'paused' ? 'paused' : 'idle'
  return (
    <li className={`desk ${selected ? 'selected' : ''} ${working ? 'busy' : ''}`} data-desk={a.id} style={{ '--hue': hue(a.id) }}>
      <button type="button" className="desk-btn" onClick={onSelect} aria-pressed={selected} aria-label={`${a.name}, ${state}. Open terminal`}>
        <img className="clawd" src={clawdUrl(set)} alt="" width="192" height="64" draggable="false"
          onError={e => { if (!e.currentTarget.dataset.fell) { e.currentTarget.dataset.fell = 1; e.currentTarget.src = clawdUrl('idle') } }} />
        <span className="plate"><span className="title clip">{a.name}</span><Badge status={state}>{state.replace('_', ' ')}</Badge></span>
        <span className="muted small clip mono">{line}</span>
        {r?.pending_permission?.length > 0 && <span className="wait small">Waiting for your permission</span>}
      </button>
      {bubble && <Bubble b={bubble} />}
    </li>
  )
}

const Bubble = ({ b }) => (
  <span className={`speech ${b.kind === 'question' ? 'q' : ''}`} role="status">
    <b>{b.from}</b> {b.text.length > 140 ? b.text.slice(0, 140) + '...' : b.text}
  </span>
)

// Crew messages as a conversation: avatars, bubbles, consecutive messages from one sender grouped.
export function CrewThread({ crew }) {
  const box = useRef()
  const n = crew?.length
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [n])
  if (!crew?.length) return <p className="empty thread-empty">Agents have not talked yet. Their messages to each other show up here and fly across the floor.</p>
  return (
    <ol className="thread" ref={box} aria-label="Crew conversation">
      {crew.map((m, i) => {
        const prev = crew[i - 1]
        const first = !prev || prev.from_agent_id !== m.from_agent_id || prev.to_agent_id !== m.to_agent_id || prev.to_owner !== m.to_owner
        const mine = m.from_agent_id == null
        const to = m.to_owner ? 'you' : m.to_name || 'everyone'
        return (
          <li key={m.id} className={`say ${mine ? 'mine' : ''} ${first ? 'first' : ''}`} style={{ '--hue': hue(m.from_agent_id) }}>
            {first && <span className="avatar sm" aria-hidden="true">{initials(m.from_name || 'You')}</span>}
            <div className="say-body">
              {first && <div className="say-meta"><b>{m.from_name || 'You'}</b> to {to}{m.kind !== 'message' && <span className="pill">{m.kind}</span>} <span className="muted">{ago(m.created_at)}</span></div>}
              <p className="say-bubble pre">{m.text}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
