import { useEffect, useRef, useState } from 'react'

export function Button({ variant = 'default', small, className = '', ...p }) {
  return <button type="button" className={`btn ${variant} ${small ? 'small' : ''} ${className}`} {...p} />
}

export function StatusDot({ status }) {
  return <span className={`dot s-${status}`} title={status}><span className="sr-only">{status}</span></span>
}

// Six owner words for the many internal statuses; the API keeps its own. Others (planned, ok) show as they are.
const OWNER = {
  wait: ['Waiting for you', 'awaiting_approval plan question permission'],
  work: ['Working', 'in_progress running working planning'],
  check: ['Being checked', 'in_review qa'],
  merge: ['Ready to merge', 'done ready_to_merge merge'],
  shipped: ['Shipped', 'merged'],
  stuck: ['Stuck', 'blocked error failed failure killed rejected'],
  canceled: ['Canceled', 'canceled'],
}
const GROUP = Object.fromEntries(Object.entries(OWNER).flatMap(([g, [, s]]) => s.split(' ').map(x => [x, g])))

export function Badge({ status, children }) {
  const g = GROUP[status]
  return <span className={`badge s-${status}${g ? ` g-${g}` : ''}`}>{children || (g ? OWNER[g][0] : label(status))}</span>
}

// A merged task, or an order whose PRs all merged, reads Shipped rather than done.
export const taskStatus = t => (t.merged ? 'merged' : t.status)
export const orderStatus = o => (o.status === 'done' ? 'merged' : o.status)

// Native <dialog> gives us focus trapping, Esc to close and the backdrop for free.
export function Sheet({ title, onClose, children }) {
  const ref = useRef()
  useEffect(() => {
    const d = ref.current
    d.showModal()
    return () => d.close()
  }, [])
  return (
    <dialog ref={ref} className="sheet" aria-label={title} onClose={onClose}
      onClick={e => { if (e.target === ref.current) onClose() }}>
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2>{title}</h2>
          <Button variant="ghost" className="icon" onClick={onClose} aria-label="Close">×</Button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
  )
}

export function ConfirmButton({ children, confirm = 'Confirm', onConfirm, variant = 'default', small, disabled }) {
  const [ask, setAsk] = useState(false)
  if (!ask) return <Button variant={variant} small={small} disabled={disabled} onClick={() => setAsk(true)}>{children}</Button>
  return (
    <span className="confirm" role="group">
      <Button variant="danger" small={small} autoFocus onClick={() => { setAsk(false); onConfirm() }}>{confirm}</Button>
      <Button variant="ghost" small={small} onClick={() => setAsk(false)}>Cancel</Button>
    </span>
  )
}

// Overflow menu for secondary actions. Closes on outside click only, so a ConfirmButton inside keeps its second step.
export function More({ label = 'More actions', children }) {
  const ref = useRef()
  useEffect(() => {
    const f = e => { if (ref.current?.open && !ref.current.contains(e.target)) ref.current.open = false }
    document.addEventListener('click', f)
    return () => document.removeEventListener('click', f)
  }, [])
  return (
    <details className="more" ref={ref}>
      <summary className="btn ghost small icon" aria-label={label}>⋯</summary>
      <div className="menu">{children}</div>
    </details>
  )
}

// run(fn) tracks busy and error for a button-triggered request.
export function useAction() {
  const [s, set] = useState({ busy: false, error: null })
  const run = async fn => {
    set({ busy: true, error: null })
    try { const r = await fn(); set({ busy: false, error: null }); return r }
    catch (e) { set({ busy: false, error: e.message }) }
  }
  return [run, s.busy, s.error]
}

export const ErrorText = ({ error }) => error ? <p className="error" role="alert">{error}</p> : null

export const Empty = ({ children }) => <p className="empty">{children}</p>

export const label = s => (s || '').replace(/_/g, ' ')

// Server times are UTC 'YYYY-MM-DD HH:MM:SS'.
export function ago(s) {
  if (!s) return ''
  const sec = (Date.now() - new Date(s.replace(' ', 'T') + 'Z')) / 1000
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

// Screens reached inside the app can go back; a fresh tab or a pasted link has nowhere to go back to but Home.
let moves = 0
addEventListener('hashchange', () => { moves++ })
export function BackLink({ children = 'Back' }) {
  return <a href="#/home" className="back" onClick={e => { if (moves) { e.preventDefault(); history.back() } }}>{children}</a>
}

const at = s => new Date(s.replace(' ', 'T') + 'Z')

// A relative time that shows the full local timestamp on hover.
export const Ago = ({ at: s }) => s ? <time dateTime={at(s).toISOString()} title={at(s).toLocaleString()}>{ago(s)}</time> : null

// Running time since a server timestamp, ticking every second.
export function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.round((now - (since ? at(since).getTime() : now)) / 1000))
  return <span className="elapsed">{s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`}</span>
}

export function tokens(n) {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

export const initials = name => (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()

export const ghUrl = (repo, kind, n) => `https://github.com/${repo}/${kind}/${n}`
