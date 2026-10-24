import { useLayoutEffect, useRef, useState } from 'react'
import { useEvents } from '../api.js'
import { Ago, Elapsed, initials } from '../ui.jsx'
import { clawdFor, clawdUrl } from '../clawd.js'

const FLIGHT_MS = 1200
const BUBBLE_MS = 9000
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// Stable hue per agent so a name has the same colour on the floor and in the thread.
export const hue = id => (id == null ? 28 : (id * 67) % 360)

export function light(a) {
  const r = a.run
  if (r?.status !== 'running') return a.status === 'paused' ? 'off' : 'idle'
  if (r.pending_permission?.length) return 'ask'
  if (r.state === 'paused' || r.state === 'handed_off') return 'hold'
  if (r.state === 'waiting') return 'wait'
  return 'busy'
}

// The agent space: a pixel office room. One desk per agent (its Clawd and monitor), the owner's mailbox by the door,
// notes flying between desks as agents message each other. onSelect(agent_id) shows that agent's terminal.
export default function Office({ pid, agents, crew, selected, onSelect, floor, inboxCount = 0, onComms, services = [], onServices }) {
  const room = useRef()
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
    // Support answering the owner: a bubble over its desk.
    if (ev.type === 'message' && ev.project_id === pid && ev.data.channel === 'support' && ev.data.role === 'support') {
      const desk = agents.find(a => a.role === 'support')
      if (desk) bubble(desk.id, { from: desk.name, text: ev.data.text })
      return
    }
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
    const box = room.current
    if (!box || still()) return land()
    const at = key => {
      const el = box.querySelector(`[data-desk="${key}"] .sprite-box`)
      if (!el) return null
      const r = el.getBoundingClientRect(), f = box.getBoundingClientRect()
      return { x: r.left - f.left + r.width * 0.2, y: r.top - f.top + r.height * 0.2 }
    }
    const a = at(from)
    const fl = targets.map(t => ({ id: `${m.id}-${t}`, a, b: at(t) })).filter(x => x.a && x.b)
    setFlights(f => [...f, ...fl])
    setTimeout(() => { setFlights(f => f.filter(x => !fl.includes(x))); land() }, FLIGHT_MS)
  })

  const last = crew?.[crew.length - 1]
  return (
    <div className="room" ref={room} style={floor && { '--floor': floor.color }}>
      <div className="room-wall">
        <span className="window" aria-hidden="true" /><span className="window" aria-hidden="true" /><span className="window" aria-hidden="true" />
        <span className="sign" aria-hidden="true">{floor && floor.key !== 'tech' ? `${floor.name} floor` : 'CREW HQ'}</span>
        <Rack services={services} onOpen={onServices} />
        <div className="mailbox" data-desk="owner" title="Your mail tray">
          <span className="sprite-box mail-sprite" aria-hidden="true"><span /></span>
          <span className="tag">You{inboxCount > 0 && <b className="tag-count">{inboxCount}</b>}</span>
          {bubbles.owner && <Bubble b={bubbles.owner} />}
        </div>
      </div>
      <Plant />
      <ul className="floor-desks">
        {agents.map(a => (
          <Station key={a.id} a={a} set={moments[a.id] || clawdFor(a, a.run)} bubble={bubbles[a.id]} selected={selected === a.id} onSelect={() => onSelect(a.id)} />
        ))}
      </ul>
      {flights.map(f => (
        <span key={f.id} className="note-flight" aria-hidden="true"
          style={{ left: f.a.x, top: f.a.y, '--dx': `${f.b.x - f.a.x}px`, '--dy': `${f.b.y - f.a.y}px`, animationDuration: `${FLIGHT_MS}ms` }} />
      ))}
      <button type="button" className="comms-ticker" onClick={onComms} title="Open the crew conversation">
        <img src={clawdUrl('pass-note')} alt="" width="72" height="24" />
        {last ? <span className="clip"><b>{last.from_name || 'You'}</b> to {last.to_owner ? 'you' : last.to_name || 'everyone'}: {last.text}</span> : <span className="clip">No crew messages yet</span>}
        <span className="ticker-more">Comms</span>
      </button>
    </div>
  )
}

// A server rack on the wall: one lit unit per running service. Click for logs, stop and restart.
function Rack({ services, onOpen }) {
  const up = (services || []).filter(s => s.status === 'running')
  return (
    <button type="button" className={`rack ${up.length ? 'on' : ''}`} onClick={onOpen} title={up.length ? up.map(s => `${s.name}${s.url ? ` ${s.url}` : ''}`).join(', ') : 'No services running'}>
      <span className="rack-units" aria-hidden="true">{[0, 1, 2].map(i => <i key={i} className={i < up.length ? 'lit' : ''} />)}</span>
      <span className="tag">{up.length ? `${up.length} up` : 'Services'}</span>
    </button>
  )
}

function Station({ a, set, bubble, selected, onSelect }) {
  const r = a.run, lt = light(a)
  const doing = r?.status === 'running' ? (r.task_title || r.last_event || 'Starting') : lt === 'off' ? 'Paused' : 'Idle'
  return (
    <li className={`station ${selected ? 'selected' : ''} l-${lt}`} data-desk={a.id} style={{ '--hue': hue(a.id) }}>
      {bubble && <Bubble b={bubble} />}
      <button type="button" className="station-btn" onClick={onSelect} aria-pressed={selected} aria-label={`${a.name}: ${doing}. Show terminal`}>
        <span className="sprite-box">
          <span className="monitor" aria-hidden="true" />
          <img className="sprite" src={clawdUrl(set)} alt="" draggable="false"
            onError={e => { if (!e.currentTarget.dataset.fell) { e.currentTarget.dataset.fell = 1; e.currentTarget.src = clawdUrl('idle') } }} />
        </span>
        <span className="desk" aria-hidden="true" />
        <span className="tag"><i className="light" />{a.name}</span>
        <span className="doing clip">{doing}{r?.status === 'running' && r.started_at && <> <Elapsed since={r.started_at} /></>}</span>
      </button>
    </li>
  )
}

const Bubble = ({ b }) => (
  <span className={`speech ${b.kind === 'question' ? 'q' : ''}`} role="status">
    <b>{b.from}:</b> {b.text.length > 110 ? b.text.slice(0, 110) + '...' : b.text}
  </span>
)

// 16x16 pixel plant; crisp at any scale.
const Plant = () => (
  <svg className="plant" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges">
    <rect x="7" y="2" width="2" height="5" fill="#5fa35a" /><rect x="4" y="4" width="3" height="2" fill="#6fbf69" />
    <rect x="9" y="3" width="3" height="2" fill="#6fbf69" /><rect x="3" y="6" width="4" height="2" fill="#5fa35a" />
    <rect x="9" y="6" width="4" height="2" fill="#5fa35a" /><rect x="7" y="7" width="2" height="3" fill="#4a8a46" />
    <rect x="4" y="10" width="8" height="5" fill="#b56a45" /><rect x="4" y="10" width="8" height="1" fill="#c97d55" />
  </svg>
)

// Crew messages as a conversation: avatars, bubbles, consecutive messages from one sender grouped.
export function CrewThread({ crew }) {
  const box = useRef()
  const n = crew?.length
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [n])
  if (!crew?.length) return <p className="empty">Agents have not talked yet. Their messages to each other show up here and fly across the office.</p>
  return (
    <ol className="cm-thread" ref={box} aria-label="Crew conversation">
      {crew.map((m, i) => {
        const prev = crew[i - 1]
        const first = !prev || prev.from_agent_id !== m.from_agent_id || prev.to_agent_id !== m.to_agent_id || prev.to_owner !== m.to_owner
        const mine = m.from_agent_id == null
        const to = m.to_owner ? 'you' : m.to_name || 'everyone'
        return (
          <li key={m.id} className={`cm ${mine ? 'mine' : ''} ${first ? 'first' : ''}`} style={{ '--hue': hue(m.from_agent_id) }}>
            {first && <span className="avatar sm" aria-hidden="true">{initials(m.from_name || 'You')}</span>}
            <div className="cm-body">
              {first && <div className="cm-meta"><b>{m.from_name || 'You'}</b> to {to}{m.kind !== 'message' && <span className="pill">{m.kind}</span>} <span className="muted"><Ago at={m.created_at} /></span></div>}
              <p className="cm-bubble pre">{m.text}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
