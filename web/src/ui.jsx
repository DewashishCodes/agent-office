import { useEffect, useRef, useState } from 'react'

export function Button({ variant = 'default', small, className = '', ...p }) {
  return <button type="button" className={`btn ${variant} ${small ? 'small' : ''} ${className}`} {...p} />
}

export function StatusDot({ status }) {
  return <span className={`dot s-${status}`} title={status}><span className="sr-only">{status}</span></span>
}

export function Badge({ status, children }) {
  return <span className={`badge s-${status}`}>{children || label(status)}</span>
}

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

export function tokens(n) {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

export const initials = name => (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()

export const ghUrl = (repo, kind, n) => `https://github.com/${repo}/${kind}/${n}`
