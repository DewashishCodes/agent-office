import { Component, useEffect, useState } from 'react'
import { api, on, setAuthHandler, useData } from './api.js'
import { Button, ConfirmButton, ErrorText, More, tokens, useAction } from './ui.jsx'
import Login from './screens/Login.jsx'
import Projects from './screens/Projects.jsx'
import Command from './screens/Command.jsx'
import Board from './screens/Board.jsx'
import Team from './screens/Team.jsx'
import AgentProfile from './screens/AgentProfile.jsx'
import Inbox from './screens/Inbox.jsx'
import Wall from './screens/Wall.jsx'
import Home from './screens/Home.jsx'
import Vault from './screens/Vault.jsx'
import Onboarding from './screens/Onboarding.jsx'

const ICONS = {
  home: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
  command: 'M4 5h16v11H9l-5 4z',
  wall: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a2.5 2.5 0 1 0 0-5M17 14c2.3.4 4 2.6 4 6',
  board: 'M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z',
}
const TABS = [['home', 'Home'], ['command', 'Command'], ['wall', 'Agents'], ['board', 'Board']]
// Screens without their own tab light up the closest one.
const TAB_OF = { inbox: 'home', vault: 'home', team: 'wall', agent: 'wall', onboarding: 'home' }

// '#/agent/12' -> { view: 'agent', id: 12 }
function parseHash() {
  const [, view = 'home', id] = location.hash.split('/')
  return { view: view || 'home', id: id ? Number(id) : null }
}

export default function App() {
  const [authed, setAuthed] = useState(null)
  useEffect(() => {
    setAuthHandler(setAuthed)
    api('/me').then(() => setAuthed(true), () => setAuthed(false))
  }, [])
  if (authed === null) return <div className="splash">Loading</div>
  if (!authed) return <Login onDone={() => setAuthed(true)} />
  return <Shell />
}

function Shell() {
  const [route, setRoute] = useState(parseHash)
  // Desktop sidebar: an icon rail unless the owner opens it; the choice sticks.
  const [navOpen, setNavOpen] = useState(() => { try { return localStorage.getItem('crew.nav') === 'open' } catch { return false } })
  const toggleNav = () => setNavOpen(o => { try { localStorage.setItem('crew.nav', o ? 'min' : 'open') } catch {} return !o })
  useEffect(() => {
    const f = () => { setRoute(parseHash()); window.scrollTo(0, 0) }
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
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
  const project = projects?.find(p => p.id === pick) || projects?.[0] || null
  const pid = project?.id ?? null

  const [detail, reloadDetail] = useData(pid && `/projects/${pid}`,
    ev => ev.project_id === pid && (ev.type === 'project' || (ev.type === 'run' && ev.data.status !== 'running')))
  const [openInbox] = useData(pid && `/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))

  if (!projects) return <div className="splash">{projectsError ? <ErrorText error={projectsError} /> : 'Loading'}</div>

  const showProjects = !project || route.view === 'projects'
  const view = showProjects ? 'projects' : route.view
  const p = detail || project
  const ctx = { pid, project: p, reloadProject: reloadDetail, floors, floor, setFloor }

  let screen
  if (showProjects) screen = <Projects projects={projects} current={pid} reload={reloadProjects} onPick={(id, hash = '#/home') => { choose(id); location.hash = hash }} />
  else if (view === 'board') screen = <Board key={route.id} {...ctx} orderId={route.id} />
  else if (view === 'team') screen = <Team {...ctx} />
  else if (view === 'agent') screen = <AgentProfile key={route.id} {...ctx} id={route.id} />
  else if (view === 'inbox') screen = <Inbox {...ctx} />
  else if (view === 'wall') screen = <Wall {...ctx} />
  else if (view === 'vault') screen = <Vault {...ctx} />
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
              {id === 'home' && count > 0 && <span className="count" aria-label={`${count} open`}>{count}</span>}
            </a>
          ))}
        </nav>
      )}
      <div className="main">
        {project && (
          <Header projects={projects} project={p} detail={detail} onPick={choose} reload={reloadDetail} />
        )}
        {p?.paused ? <Paused pid={pid} reload={reloadDetail} /> : null}
        {view !== 'onboarding' && ['interviewing', 'proposed'].includes(p?.onboarding_status) && (
          <a className="banner onboard-banner" href="#/onboarding">{p.onboarding_status === 'proposed' ? 'Your office proposal is ready. Review and approve it.' : 'Onboarding is in progress. Answer the questions to set up your office.'}</a>
        )}
        <main id="content" key={pid}><Boundary key={route.view}>{screen}</Boundary></main>
      </div>
    </div>
  )
}

function Header({ projects, project, detail, onPick, reload }) {
  const [run, busy, error] = useAction()
  const util = detail?.rate_limit?.utilization
  const pct = util == null ? null : Math.round(util <= 1 ? util * 100 : util)
  const budget = project.settings?.project_daily_token_budget
  const [day, toggleTheme] = useTheme()
  const kill = () => run(async () => { await api(`/projects/${project.id}/kill`, { method: 'POST' }); reload() })
  const logout = () => run(async () => { await api('/logout', { method: 'POST' }); location.reload() })

  return (
    <header className="top">
      <label className="sr-only" htmlFor="project-pick">Project</label>
      <select id="project-pick" className="project-pick" value={project.id}
        onChange={e => e.target.value === 'new' ? (location.hash = '#/projects') : onPick(Number(e.target.value))}>
        {projects.map(p => <option key={p.id} value={p.id}>{p.repo}</option>)}
        <option value="new">Add or manage projects</option>
      </select>
      <div className="stats" aria-label="Usage">
        {detail && <span className="cost" title="Spent today">${(detail.cost_today || 0).toFixed(2)}</span>}
        {detail && <Gauge className="tok-today" title={`Tokens used today${budget ? ` of the ${tokens(budget)} project budget` : ''}`}
          pct={budget ? (detail.tokens_today / budget) * 100 : null}>{tokens(detail.tokens_today)}{budget ? ` / ${tokens(budget)}` : ''} tok</Gauge>}
        {pct != null && <Gauge title="Five hour rate limit used" pct={pct}>5h {pct}%</Gauge>}
      </div>
      <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={day ? 'Switch to night shift' : 'Switch to day shift'} title={day ? 'Night shift' : 'Day shift'}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={day ? 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' : 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5'} /></svg>
      </button>
      {!project.paused && (
        <ConfirmButton small variant="ghost" confirm="Stop every agent" onConfirm={kill} disabled={busy}>Stop all</ConfirmButton>
      )}
      <More label="Menu">
        <a className="btn ghost" href="#/projects">Projects</a>
        <Button variant="ghost" onClick={logout}>Log out</Button>
      </More>
      <ErrorText error={error} />
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
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', day ? '#f4efe3' : '#16130f')
    try { localStorage.setItem('crew.theme', day ? 'day' : 'night') } catch {}
  }, [day])
  return [day, () => setDay(d => !d)]
}

function Gauge({ pct, title, className = '', children }) {
  const p = pct == null ? null : Math.min(100, Math.round(pct))
  return (
    <span className={`gauge ${className} ${p >= 80 ? 'hot' : ''}`} title={title}>
      <span>{children}</span>
      {p != null && <i aria-hidden="true"><b style={{ width: `${p}%` }} /></i>}
    </span>
  )
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
