import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, useEvents } from '../api.js'
import { tokens } from '../ui.jsx'

// Markdown-lite: fenced blocks, inline code and bold only.
export function Md({ text }) {
  return String(text).split(/```[^\n]*\n?/).map((part, i) => i % 2
    ? <pre key={i} className="code">{part.replace(/\n$/, '')}</pre>
    : <span key={i}>{part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((s, j) =>
      s.startsWith('`') && s.endsWith('`') && s.length > 2 ? <code key={j}>{s.slice(1, -1)}</code>
      : s.startsWith('**') && s.endsWith('**') && s.length > 4 ? <b key={j}>{s.slice(2, -2)}</b> : s)}</span>)
}

// "C:/a/b/crew-t4/web/src/App.jsx" -> "web/src/App.jsx": worktree paths are long and the prefix says nothing.
const short = p => String(p).replaceAll('\\', '/').replace(/^.*\/crew-t\d+\//, '').replace(/^.*\/repos\/[^/]+\//, '')

function toolLine(c) {
  const i = c.input || {}
  const arg = i.file_path || i.notebook_path || i.command || i.pattern || i.path || i.url || i.query || i.to || i.description || ''
  return `${c.name.replace(/^mcp__crew__/, '')} ${short(String(arg).split('\n')[0])}`.trim().slice(0, 160)
}

const resultText = c => typeof c.content === 'string' ? c.content
  : Array.isArray(c.content) ? c.content.map(x => x.text || (x.type === 'image' ? '[image]' : '')).join('\n') : ''

function Row({ e }) {
  let j
  try { j = JSON.parse(e.json) } catch { return null }
  if (e.type === 'prompt') return (
    <li className="ev prompt"><details><summary>Task prompt</summary><pre className="code">{j.text}</pre></details></li>
  )
  if (e.type === 'owner') return <li className="ev owner"><span className="who">You</span> <span className="pre">{j.text}</span></li>
  if (e.type === 'note') return <li className="ev note">{j.text}</li>
  if (e.type === 'control_request') return <li className="ev ask">Asks to run: <span className="mono">{j.summary}</span></li>
  if (e.type === 'result') return (
    <li className={`ev result ${j.is_error ? 'bad' : ''}`}>
      <span>{j.is_error ? (j.subtype === 'error_during_execution' ? 'Stopped' : 'Turn failed') : 'Turn done'}</span>
      <span className="muted">{tokens((j.input_tokens || 0) + (j.output_tokens || 0))} tok, ${Number(j.cost_usd || 0).toFixed(2)}</span>
    </li>
  )
  const items = j.content || []
  return items.map((c, k) => {
    if (c.type === 'text' && c.text) return <li key={k} className={`ev ${e.type === 'assistant' ? 'say' : 'note'}`}><Md text={c.text} /></li>
    if (c.type === 'tool_use') return (
      <li key={k} className="ev tool"><details><summary className="mono">{toolLine(c)}</summary><pre className="code">{JSON.stringify(c.input, null, 2)}</pre></details></li>
    )
    if (c.type === 'tool_result') {
      const t = resultText(c)
      return (
        <li key={k} className={`ev tool-result ${c.is_error ? 'bad' : ''}`}>
          <details><summary className="mono">{c.is_error ? 'error: ' : ''}{t.split('\n')[0].slice(0, 120) || '(no output)'}</summary><pre className="code">{t.slice(0, 2000)}</pre></details>
        </li>
      )
    }
    return null
  })
}

// Live transcript of one run: fetch the tail once, then append run_event rows and run_delta text from SSE.
export default function Transcript({ runId, tail = 40, className = '' }) {
  const [events, setEvents] = useState([])
  const [pending, setPending] = useState('')
  const [error, setError] = useState(null)
  const box = useRef()
  const stick = useRef(true)

  const load = useCallback(() => {
    if (!runId) return
    api(`/runs/${runId}/events?tail=${tail}`).then(rows => { setEvents(rows); setError(null) }, e => setError(e.message))
  }, [runId, tail])
  useEffect(() => { setEvents([]); setPending(''); load() }, [load])

  useEvents(ev => {
    if (ev.type === 'open') return load()
    if (ev.data?.run_id !== runId) return
    if (ev.type === 'run_event') {
      setEvents(es => es.some(x => x.seq === ev.data.seq) ? es : [...es, ev.data].slice(-tail))
      if (ev.data.type === 'assistant' || ev.data.type === 'result') setPending('')
    } else if (ev.type === 'run_delta') setPending(p => p + ev.data.text)
  })

  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events, pending])

  if (!runId) return <div className={`transcript empty-t ${className}`}>No runs yet</div>
  return (
    <ol className={`transcript ${className}`} ref={box} aria-live="off"
      onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
      {error && <li className="ev note">{error}</li>}
      {events.map(e => <Row key={e.seq} e={e} />)}
      {pending && <li className="ev say live-text"><Md text={pending} /></li>}
    </ol>
  )
}
