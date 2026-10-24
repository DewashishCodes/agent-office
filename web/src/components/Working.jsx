import { useEffect, useState } from 'react'
import { clawdFor, clawdUrl } from '../clawd.js'

// Shown while an agent works on a reply: its Clawd acting out the current tool, what it is doing, and for how long.
export default function Working({ text, lastEvent, since, set: shown }) {
  const [start] = useState(() => since ? new Date(since.replace(' ', 'T') + 'Z').getTime() : Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.round((now - start) / 1000))
  const set = shown || clawdFor({}, { status: 'running', state: 'running', last_event: lastEvent || null })
  return (
    <div className="working" role="status">
      <img src={clawdUrl(set)} alt="" width="120" height="40" />
      <div className="grow">
        <div>{text} <span className="muted small">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span></div>
        {lastEvent && <div className="mono muted small clip">{lastEvent}</div>}
      </div>
    </div>
  )
}
