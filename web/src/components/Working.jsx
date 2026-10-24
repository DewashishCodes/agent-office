import { useState } from 'react'
import { Elapsed } from '../ui.jsx'
import { clawdFor, clawdUrl } from '../clawd.js'

// Shown while an agent works on a reply: its Clawd acting out the current tool, what it is doing, and for how long.
export default function Working({ text, lastEvent, since, set: shown }) {
  // No since: count from when this appeared.
  const [start] = useState(() => since || new Date().toISOString().slice(0, 19).replace('T', ' '))
  const set = shown || clawdFor({}, { status: 'running', state: 'running', last_event: lastEvent || null })
  return (
    <div className="working" role="status">
      <img src={clawdUrl(set)} alt="" width="120" height="40" />
      <div className="grow">
        <div>{text} <span className="muted small"><Elapsed since={start} /></span></div>
        {lastEvent && <div className="mono muted small clip">{lastEvent}</div>}
      </div>
    </div>
  )
}
