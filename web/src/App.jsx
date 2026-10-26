import { Component, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, on, setAuthHandler, useData } from './api.js'
import { Button, ConfirmButton, ErrorText, More, tokens, useAction } from './ui.jsx'
import Login from './screens/Login.jsx'
import Projects from './screens/Projects.jsx'
import Command from './screens/Command.jsx'
import Board from './screens/Board.jsx'
import Team from './screens/Team.jsx'
import AgentProfile from './screens/AgentProfile.jsx'
import Inbox, { KIND, NotifyCard } from './screens/Inbox.jsx'
import Home from './screens/Home.jsx'
import Vault from './screens/Vault.jsx'
import Onboarding from './screens/Onboarding.jsx'
import Activity from './screens/Activity.jsx'
import { FloorBar, OpenFloorSheet, currentFloor, openFloors } from './components/Floors.jsx'

const ICONS = {
  home: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
  command: 'M4 5h16v11H9l-5 4z',
  team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a2.5 2.5 0 1 0 0-5M17 14c2.3.4 4 2.6 4 6',
  board: 'M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z',
  inbox: 'M4 13l2.5-8h11l2.5 8v6H4zM4 13h5l1 2h4l1-2h5',
}
const TABS = [['home', 'Home'], ['command', 'Command'], ['inbox', 'Needs you'], ['team', 'Agents'], ['board', 'Board']]
// Screens without their own tab light up the closest one.
const TAB_OF = { vault: 'home', agent: 'team', wall: 'team', onboarding: 'home', activity: 'board' }
// g then a letter switches tab; / focuses the message box. Listed in the header menu.
const GO_KEYS = { h: 'home', c: 'command', b: 'board', n: 'inbox', a: 'team' }

// '#/agent/12' -> { view: 'agent', id: 12 }; a push deep link '#/inbox/<item>/<project>' also names the project.
function parseHash() {
  const [, view = 'home', id, project] = location.hash.split('/')
  return { view: view || 'home', id: id ? Number(id) : null, project: project ? Number(project) : null }
}

export default function App() {
  const [authed, setAuthed] = useState(null)
  const [restarted, setRestarted] = useState(false)
  const check = () => api('/me').then(me => { setAuthed(true); setRestarted(!!me?.restarted) }, e => setAuthed(e.offline ? 'offline' : false))
  useEffect(() => {
    setAuthHandler(setAuthed)
    check()
  }, [])
  if (authed === null) return <div className="splash">Loading</div>
  if (authed === 'offline') return <Offline onRetry={check} />
  if (!authed) return <Login onDone={() => setAuthed(true)} />
  return <Shell restarted={restarted} />
}

// The last open Needs you list this device saw, kept for the offline screen.
function Offline({ onRetry }) {
  const [busy, setBusy] = useState(false)
  let items = []
  try { items = JSON.parse(localStorage.getItem('crew.inbox') || '[]') } catch {}
  return (
    <main className="login offline stack">
      <h1>Can't reach your office</h1>
      <p className="muted">The PC running Agent Office is off, asleep or out of reach. Agents only work while it is on.</p>
      <Button variant="primary" disabled={busy} onClick={async () => { setBusy(true); await onRetry(); setBusy(false) }}>{busy ? 'Trying' : 'Retry'}</Button>
      {items.length > 0 && <>
        <h2>Needs you, when last seen</h2>
        <ul className="list">{items.map(i => <li key={i.id} className="card"><span className="muted small">{KIND[i.kind] || i.kind}</span> {i.title}</li>)}</ul>
      </>}
    </main>
  )
}

function Shell({ restarted }) {
  const [route, setRoute] = useState(parseHash)
  // Desktop sidebar: an icon rail unless the owner opens it; the choice sticks.
  const [navOpen, setNavOpen] = useState(() => { try { return localStorage.getItem('crew.nav') === 'open' } catch { return false } })
  const toggleNav = () => setNavOpen(o => { try { localStorage.setItem('crew.nav', o ? 'min' : 'open') } catch {} return !o })
  useEffect(() => {
    // Screens cross-fade through the View Transitions API where the browser has it; the CSS is on ::view-transition-*.
    const go = () => { setRoute(parseHash()); window.scrollTo(0, 0) }
    const f = () => document.startViewTransition ? document.startViewTransition(() => flushSync(go)) : go()
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  useEffect(() => {
    let g = 0
    const f = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable], .xterm, dialog')) return
      if (e.key === '/') { const c = document.querySelector('#order-text, #hq-order'); if (c) { e.preventDefault(); c.focus() } }
      else if (g && Date.now() - g < 1000 && GO_KEYS[e.key]) location.hash = `#/${GO_KEYS[e.key]}`
      g = e.key === 'g' ? Date.now() : 0
    }
    addEventListener('keydown', f)
    return () => removeEventListener('keydown', f)
  }, [])

  const [projects, reloadProjects, projectsError] = useData('/projects', ev => ev.type === 'project')
  const [pick, setPick] = useState(() => { try { return Number(localStorage.getItem('crew.project')) || null } catch { return null } })
  const choose = id => {
    setPick(id)
    try { localStorage.setItem('crew.project', String(id)) } catch {}
  }
  // The floor the owner is on, shared by Home and Command.
  const [floors] = useData('/floors')
  const [floor, setFloorState] = useState(() => { try { return localStorage.getItem('crew.floor') || 'tech' } catch { return 'tech' } })
  const setFloor = f => { setFloorState(f); try { localStorage.setItem('crew.floor', f) } catch {} }
  useEffect(() => { if (route.project && route.project !== pick) choose(route.project) }, [route.project])
  const project = projects?.find(p => p.id === pick) || projects?.[0] || null
  const pid = project?.id ?? null

  const [detail, reloadDetail] = useData(pid && `/projects/${pid}`,
    ev => ev.project_id === pid && (ev.type === 'project' || (ev.type === 'run' && ev.data.status !== 'running')))
  const [openInbox] = useData(pid && `/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))
  // For the floor switcher: which floors are open, and whether an agent there waits on the owner.
  const [agents] = useData(pid && `/projects/${pid}/agents`, ev => ev.project_id === pid && (ev.type === 'agent' || ev.type === 'run'))
  useEffect(() => {
    if (!openInbox) return
    try { localStorage.setItem('crew.inbox', JSON.stringify(openInbox.map(({ id, kind, title }) => ({ id, kind, title })))) } catch {}
    // The count on the installed app's icon; browsers without the Badging API skip it.
    if ('setAppBadge' in navigator) (openInbox.length ? navigator.setAppBadge(openInbox.length) : navigator.clearAppBadge()).catch(() => {})
  }, [openInbox])

  if (!projects) return <div className="splash">{projectsError ? <ErrorText error={projectsError} /> : 'Loading'}</div>

  const showProjects = !project || route.view === 'projects'
  const view = showProjects ? 'projects' : route.view
  const p = detail || project
  const ctx = { pid, project: p, reloadProject: reloadDetail, floors, floor, setFloor }

  let screen
  if (showProjects) screen = <Projects projects={projects} current={pid} reload={reloadProjects} onPick={(id, hash = '#/home') => { choose(id); location.hash = hash }} />
  else if (view === 'board') screen = <Board key={route.id} {...ctx} orderId={route.id} />
  // The Wall folded into Home and Team; old #/wall links land on Team.
  else if (view === 'team' || view === 'wall') screen = <Team {...ctx} />
  else if (view === 'agent') screen = <AgentProfile key={route.id} {...ctx} id={route.id} />
  else if (view === 'inbox') screen = <Inbox {...ctx} itemId={route.id} />
  else if (view === 'vault') screen = <Vault {...ctx} />
  else if (view === 'activity') screen = <Activity {...ctx} />
  else if (view === 'onboarding') screen = <Onboarding {...ctx} />
  else if (view === 'command') screen = <Command {...ctx} running={detail?.running_runs} />
  else screen = <Home {...ctx} />

  const tab = TAB_OF[view] || view
  const count = openInbox?.length || 0

  return (
    <div className={`app ${navOpen ? 'nav-open' : 'nav-min'}`}>
      {project && (
        <nav className="tabs" aria-label="Main">
          <div className="brand">
            <img src="/favicon.svg" alt="" width="24" height="24" /><span className="brand-name">Agent Office</span>
            <button type="button" className="nav-toggle" onClick={toggleNav} aria-expanded={navOpen} aria-label={navOpen ? 'Collapse sidebar' : 'Expand sidebar'} title={navOpen ? 'Collapse sidebar' : 'Expand sidebar'}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={navOpen ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} /></svg>
            </button>
          </div>
          {TABS.map(([id, name]) => (
            <a key={id} href={`#/${id}`} className={`tab ${id}-tab`} title={name} aria-current={tab === id ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d={ICONS[id]} /></svg>
              <span className="tab-name">{name}</span>
              {id === 'inbox' && count > 0 && <span className="count" aria-label={`${count} open`}>{count}</span>}
            </a>
          ))}
        </nav>
      )}
      <div className="main">
        {project && (
          <Header projects={projects} project={p} detail={detail} onPick={choose} reload={reloadDetail}
            floorBar={['home', 'command'].includes(view) && agents && { floors, floor, setFloor, agents }} />
        )}
        {p?.paused ? <Paused pid={pid} reload={reloadDetail} /> : null}
        {project && <NotifyCard />}
        {restarted && <p className="banner" role="status">The crew server just came back from a crash, power loss or sleep. Interrupted tasks went back in the queue. See Keep it running in the README.</p>}
        {view !== 'onboarding' && ['interviewing', 'proposed'].includes(p?.onboarding_status) && (
          <a className="banner onboard-banner" href="#/onboarding">{p.onboarding_status === 'proposed' ? 'Your office proposal is ready. Review and approve it.' : 'Onboarding is in progress. Answer the questions to set up your office.'}</a>
        )}
        <main id="content" key={pid}><Boundary key={route.view}>{screen}</Boundary></main>
      </div>
    </div>
  )
}

function Header({ projects, project, detail, onPick, reload, floorBar }) {
  const [run, busy, error] = useAction()
  const [addFloor, setAddFloor] = useState(false)
  const [templates] = useData(addFloor ? '/templates' : null)
  const open = floorBar && openFloors(floorBar.floors, floorBar.agents)
  const pctOf = u => (u == null ? null : Math.round(u <= 1 ? u * 100 : u))
  const pct = pctOf(detail?.rate_limit?.utilization), week = pctOf(detail?.rate_limit_week?.utilization)
  const budget = project.settings?.project_daily_token_budget
  const [day, toggleTheme] = useTheme()
  const kill = () => run(async () => { await api(`/projects/${project.id}/kill`, { method: 'POST' }); reload() })
  const logout = all => run(async () => { await api('/logout', { method: 'POST', body: { all } }); location.reload() })

  return (
    <header className="top">
      <label className="sr-only" htmlFor="project-pick">Project</label>
      <select id="project-pick" className="project-pick" value={project.id}
        onChange={e => e.target.value === 'new' ? (location.hash = '#/projects') : onPick(Number(e.target.value))}>
        {projects.map(p => <option key={p.id} value={p.id}>{p.repo}</option>)}
        <option value="new">Add or manage projects</option>
      </select>
      {floorBar && <FloorBar open={open} agents={floorBar.agents} floor={currentFloor(open, floorBar.floor).key} onPick={floorBar.setFloor}
        onAdd={() => setAddFloor(true)} canAdd={open.length < (floorBar.floors?.length || 0)} />}
      <div className="stats" aria-label="Usage">
        {detail && <Stat className="cost-stat" title="Spent today"><b className="cost">$<Tween n={detail.cost_today || 0} /></b></Stat>}
        {detail && <Stat className="tok-today" title={`Tokens used today${budget ? ` of the ${tokens(budget)} project budget` : ''}`}
          pct={budget ? (detail.tokens_today / budget) * 100 : null}><b>{tokens(detail.tokens_today)}</b>{budget ? ` / ${tokens(budget)}` : ''} tok</Stat>}
        {pct != null && <Stat title="Five hour rate limit used" pct={pct}>5h <b>{pct}%</b></Stat>}
        {week != null && <Stat className="week" title="Weekly limit used" pct={week}>7d <b>{week}%</b></Stat>}
      </div>
      <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={day ? 'Switch to night shift' : 'Switch to day shift'} title={day ? 'Night shift' : 'Day shift'}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={day ? 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' : 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5'} /></svg>
      </button>
      <More label="Menu">
        {!project.paused && <ConfirmButton variant="ghost" confirm="Stop every agent" onConfirm={kill} disabled={busy}>Stop all agents</ConfirmButton>}
        <a className="btn ghost" href="#/projects">Projects</a>
        <Button variant="ghost" onClick={() => logout(false)}>Log out</Button>
        <ConfirmButton variant="ghost" confirm="Sign out every device" onConfirm={() => logout(true)} disabled={busy}>Log out everywhere</ConfirmButton>
        <p className="menu-keys muted small"><kbd>/</kbd> message box, <kbd>g</kbd> then <kbd>h</kbd> Home, <kbd>c</kbd> Command, <kbd>n</kbd> Needs you, <kbd>a</kbd> Agents, <kbd>b</kbd> Board</p>
      </More>
      <ErrorText error={error} />
      {addFloor && <OpenFloorSheet pid={project.id} floors={floorBar.floors} open={open} templates={templates}
        onOpened={k => { setAddFloor(false); floorBar.setFloor(k) }} onClose={() => setAddFloor(false)} />}
    </header>
  )
}

// Night shift by default; the choice sticks and index.html applies it before first paint.
function useTheme() {
  const [day, setDay] = useState(() => document.documentElement.dataset.theme === 'day')
  useEffect(() => {
    const el = document.documentElement
    if (day) el.dataset.theme = 'day'
    else delete el.dataset.theme
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', day ? '#f3eee4' : '#0f0e0c')
    try { localStorage.setItem('crew.theme', day ? 'day' : 'night') } catch {}
  }, [day])
  return [day, () => setDay(d => !d)]
}

function Stat({ pct, title, className = '', children }) {
  const p = pct == null ? null : Math.min(100, Math.round(pct))
  return (
    <span className={`stat ${className} ${p >= 80 ? 'hot' : ''}`} title={title}>
      <span>{children}</span>
      {p != null && <i aria-hidden="true"><b style={{ width: `${p}%` }} /></i>}
    </span>
  )
}

// A dollar amount that counts from its last value to the new one instead of jumping.
function Tween({ n }) {
  const [shown, setShown] = useState(n)
  const from = useRef(n)
  useEffect(() => {
    const a = from.current, b = n, t0 = performance.now()
    if (a === b || matchMedia('(prefers-reduced-motion: reduce)').matches) { from.current = b; setShown(b); return }
    let raf
    const step = t => {
      const k = Math.min(1, (t - t0) / 500), e = 1 - (1 - k) ** 3
      setShown(a + (b - a) * e)
      if (k < 1) raf = requestAnimationFrame(step)
      else from.current = b
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [n])
  return shown.toFixed(2)
}

function Paused({ pid, reload }) {
  const [run, busy, error] = useAction()
  return (
    <div className="banner" role="status">
      <span>Kill switch is on. No agent will start work.</span>
      <Button small disabled={busy} onClick={() => run(async () => { await api(`/projects/${pid}/resume`, { method: 'POST' }); reload() })}>Resume</Button>
      <ErrorText error={error} />
    </div>
  )
}

// One screen's render error must not blank the whole app; show it and offer a reload. key={route.view} resets it on navigation.
class Boundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error(error, info.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <section className="page stack">
        <h1>This screen hit an error</h1>
        <p className="error">{String(this.state.error?.message || this.state.error)}</p>
        <div className="actions"><Button variant="primary" onClick={() => location.reload()}>Reload</Button></div>
      </section>
    )
  }
}
