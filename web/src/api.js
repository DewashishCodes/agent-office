import { useCallback, useEffect, useRef, useState } from 'react'

let onAuth = () => {}
export const setAuthHandler = fn => { onAuth = fn }

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (res.status === 401 && path !== '/login') onAuth(false)
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data
}

// One EventSource shared by every screen.
const listeners = new Set()
let es = null

function connect() {
  es = new EventSource('/api/events')
  // 'open' also fires after a reconnect, so screens refetch whatever they missed.
  es.onopen = () => listeners.forEach(l => l({ type: 'open' }))
  es.onmessage = e => {
    let ev
    try { ev = JSON.parse(e.data) } catch { return }
    listeners.forEach(l => l(ev))
  }
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return
    es = null
    api('/me').catch(() => {})
    setTimeout(() => { if (listeners.size && !es) connect() }, 5000)
  }
}

export function useEvents(onEvent) {
  const ref = useRef(onEvent)
  useEffect(() => { ref.current = onEvent })
  useEffect(() => {
    const l = ev => ref.current(ev)
    listeners.add(l)
    if (!es) connect()
    return () => {
      listeners.delete(l)
      if (!listeners.size && es) { es.close(); es = null }
    }
  }, [])
}

export const on = (pid, ...types) => ev => types.includes(ev.type) && ev.project_id === pid

// GET path, refetch (debounced) when match(event) is true or the stream reconnects. path null = idle.
export function useData(path, match) {
  const [state, setState] = useState({ path: null, data: null, error: null })
  const cur = useRef(path)
  const timer = useRef()
  const load = useCallback(() => {
    if (!path) return Promise.resolve()
    return api(path).then(
      data => { if (cur.current === path) setState({ path, data, error: null }) },
      e => { if (cur.current === path) setState(s => ({ ...s, path, error: e.message })) },
    )
  }, [path])
  useEffect(() => { cur.current = path; load(); return () => clearTimeout(timer.current) }, [path, load])
  useEvents(ev => {
    if (ev.type === 'open' || match?.(ev)) {
      clearTimeout(timer.current)
      timer.current = setTimeout(load, 250)
    }
  })
  const fresh = state.path === path
  return [fresh ? state.data : null, load, fresh ? state.error : null]
}
