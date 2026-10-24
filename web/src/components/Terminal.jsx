import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api.js'
import Transcript from './Transcript.jsx'

const THEME = {
  background: '#141413', foreground: '#e8e6dc', cursor: '#d97757', selectionBackground: '#4a4a46',
  black: '#141413', red: '#e5534b', green: '#6bc46d', yellow: '#e0af68', blue: '#6aa8f0', magenta: '#c49af0', cyan: '#5fc4c4', white: '#e8e6dc',
  brightBlack: '#7a7a74', brightRed: '#ff7b72', brightGreen: '#8ddb8c', brightYellow: '#f2cc60', brightBlue: '#8cc0ff', brightMagenta: '#d2a8ff', brightCyan: '#7ee0e0', brightWhite: '#ffffff',
}
// Cell width per px of font size in a monospace face; used to scale a watcher to the terminal's real width.
const CELL = 0.6

// The run's real Claude Code terminal. drive: this view sets the terminal's size (the one big view on screen);
// other views follow that size and scale their font to fit. interactive: keystrokes go to the agent (after Take over).
export default function Terminal({ run, drive = false, interactive = false, className = '' }) {
  if (!run) return <div className={`terminal empty-t ${className}`}>No runs yet</div>
  if (!run.terminal) return <Transcript runId={run.id} tail={drive ? 500 : 40} className={`${className} ${drive ? 'tall' : ''}`} />
  return <Switchable key={run.id} run={run} drive={drive} interactive={interactive} className={className} />
}

// About 80 columns at a readable font; narrower, the TUI's redraws turn to noise and text reads better.
const NARROW_PX = 80 * 13 * CELL

// A terminal run as the live TUI or as text from its run events. Text by default when the run is over, on a phone,
// or in a narrow pane; the owner can flip it, and taking over always shows the terminal.
function Switchable({ run, drive, interactive, className }) {
  const box = useRef()
  const [text, setText] = useState(() => run.status !== 'running' || !matchMedia('(min-width: 900px)').matches)
  const chosen = useRef(false)
  useEffect(() => { if (!chosen.current && box.current?.clientWidth < NARROW_PX) setText(true) }, [])
  const showText = text && !interactive
  const flip = () => { chosen.current = true; setText(t => !t) }
  return (
    <div className={`term-switch ${className}`} ref={box}>
      {!interactive && <button type="button" className="btn ghost small term-flip" aria-pressed={showText} onClick={flip}>Text</button>}
      {showText
        ? <Transcript runId={run.id} tail={drive ? 500 : 40} className={drive ? 'tall' : ''} />
        : <Live id={run.id} src={`/api/runs/${run.id}/pty`} drive={drive} interactive={interactive} className={className} />}
    </div>
  )
}

// A service's output (dev server, watcher): the same terminal, read only, never resizing the process.
export const ServiceLog = ({ service, className = '' }) =>
  <Live key={`s${service.id}`} id={null} src={`/api/services/${service.id}/log`} drive={false} interactive={false} className={className} />

function Live({ id, src, drive, interactive, className }) {
  const box = useRef()
  const term = useRef()
  const keys = useRef(interactive)
  keys.current = interactive

  useEffect(() => {
    const t = new XTerm({ theme: THEME, fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace', fontSize: 13, scrollback: 5000, cursorBlink: false, allowProposedApi: false })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(box.current)
    term.current = t
    let size = { cols: 120, rows: 36 }

    // Watchers keep the agent's columns so lines wrap where the agent sees them wrap.
    const follow = () => {
      if (drive || !box.current) return
      // A service log (no run id) is plain output: it wraps to the box at a readable size.
      if (!id) { try { fit.fit() } catch {} return }
      const w = box.current.clientWidth - 8
      t.options.fontSize = Math.max(6, Math.min(13, Math.floor(w / size.cols / CELL)))
      t.resize(size.cols, Math.max(5, Math.min(size.rows, Math.floor(box.current.clientHeight / (t.options.fontSize * 1.2)))))
    }
    let timer
    const resize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!drive) return follow()
        const d = fit.proposeDimensions()
        if (!d?.cols || !d?.rows) return
        fit.fit()
        api(`/runs/${id}/pty/resize`, { method: 'POST', body: { cols: d.cols, rows: d.rows } }).catch(() => {})
      }, 150)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(box.current)

    const es = new EventSource(src)
    // A reconnect replays the whole buffer, so start from a clean screen.
    es.onopen = () => t.reset()
    es.onmessage = m => {
      const d = JSON.parse(m.data)
      if (typeof d === 'string') t.write(d)
      else if (d?.cols) { size = d; follow() }
    }
    es.addEventListener('end', () => es.close())

    // Keystrokes are batched: one request per burst, not per key.
    let buf = ''
    let flush
    const input = t.onData(d => {
      if (!keys.current) return
      buf += d
      flush ??= setTimeout(() => {
        const data = buf
        buf = ''
        flush = null
        api(`/runs/${id}/pty/input`, { method: 'POST', body: { data } }).catch(() => {})
      }, 30)
    })
    resize()
    return () => { es.close(); ro.disconnect(); input.dispose(); clearTimeout(timer); t.dispose() }
  }, [src, id, drive])

  useEffect(() => {
    const t = term.current
    if (!t) return
    t.options.cursorBlink = interactive
    if (interactive) t.focus()
  }, [interactive])

  return (
    <div className={`terminal ${interactive ? 'typing' : ''} ${drive ? 'drive' : ''} ${className}`}>
      <div className="xterm-box" ref={box} aria-label={interactive ? 'Agent terminal, you have the keyboard' : 'Agent terminal, read only'} />
      {interactive && <p className="terminal-note">You have the keyboard. Press Hand back when you are done.</p>}
    </div>
  )
}
