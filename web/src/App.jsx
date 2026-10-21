import { useEffect, useState } from 'react'
import { api, on, setAuthHandler, useData } from './api.js'
import { Button, ConfirmButton, ErrorText, tokens, useAction } from './ui.jsx'
import Login from './screens/Login.jsx'
import Projects from './screens/Projects.jsx'
import Command from './screens/Command.jsx'
import Board from './screens/Board.jsx'
import Team from './screens/Team.jsx'
import AgentProfile from './screens/AgentProfile.jsx'
import Inbox from './screens/Inbox.jsx'
import Wall from './screens/Wall.jsx'

// Wall is second on the phone; wall.css moves it first from 900px, where it is the main screen.
const TABS = [['command', 'Command'], ['wall', 'Wall'], ['board', 'Board'], ['team', 'Team'], ['inbox', 'Inbox']]

// '#/agent/12' -> { view: 'agent', id: 12 }
function parseHash() {
  const [, view = 'command', id] = location.hash.split('/')
  return { view: view || 'command', id: id ? Number(id) : null }
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
  const project = projects?.find(p => p.id === pick) || projects?.[0] || null
  const pid = project?.id ?? null

  const [detail, reloadDetail] = useData(pid && `/projects/${pid}`,
    ev => ev.project_id === pid && (ev.type === 'project' || (ev.type === 'run' && ev.data.status !== 'running')))
  const [openInbox] = useData(pid && `/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))

  if (!projects) return <div className="splash">{projectsError ? <ErrorText error={projectsError} /> : 'Loading'}</div>

  const showProjects = !project || route.view === 'projects'
  const view = showProjects ? 'projects' : route.view
  const p = detail || project
  const ctx = { pid, project: p, reloadProject: reloadDetail }

  let screen
  if (showProjects) screen = <Projects projects={projects} current={pid} reload={reloadProjects} onPick={id => { choose(id); location.hash = '#/command' }} />
  else if (view === 'board') screen = <Board key={route.id} {...ctx} orderId={route.id} />
  else if (view === 'team') screen = <Team {...ctx} />
  else if (view === 'agent') screen = <AgentProfile key={route.id} {...ctx} id={route.id} />
  else if (view === 'inbox') screen = <Inbox {...ctx} />
  else if (view === 'wall') screen = <Wall {...ctx} />
  else screen = <Command {...ctx} running={detail?.running_runs} />

  const tab = view === 'agent' ? 'team' : view
  const count = openInbox?.length || 0

  return (
    <div className="app">
      {project && (
        <nav className="tabs" aria-label="Main">
          <div className="brand"><img src="/icon.svg" alt="" width="24" height="24" /> Agent Crew</div>
          {TABS.map(([id, name]) => (
            <a key={id} href={`#/${id}`} className={`tab ${id}-tab`} aria-current={tab === id ? 'page' : undefined}>
              <span>{name}</span>
              {id === 'inbox' && count > 0 && <span className="count" aria-label={`${count} open`}>{count}</span>}
            </a>
          ))}
        </nav>
      )}
      <div className="main">
        {project && (
          <Header projects={projects} project={p} detail={detail} onPick={choose} reload={reloadDetail} />
        )}
        {p?.paused ? <Paused pid={pid} reload={reloadDetail} /> : null}
        <main id="content" key={pid}>{screen}</main>
      </div>
    </div>
  )
}

function Header({ projects, project, detail, onPick, reload }) {
  const [menu, setMenu] = useState(false)
  const [run, busy, error] = useAction()
  const util = detail?.rate_limit?.utilization
  const pct = util == null ? null : Math.round(util <= 1 ? util * 100 : util)
  const kill = () => run(async () => { await api(`/projects/${project.id}/kill`, { method: 'POST' }); reload(); setMenu(false) })
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
        {detail && <span title="Tokens used today">{tokens(detail.tokens_today)} today</span>}
        {pct != null && <span className={pct >= 80 ? 'warn' : ''} title="Five hour rate limit used">5h {pct}%</span>}
      </div>
      <div className="menu-wrap">
        <Button variant="ghost" aria-expanded={menu} aria-controls="top-menu" onClick={() => setMenu(m => !m)}>Menu</Button>
        {menu && (
          <div id="top-menu" className="menu">
            {project.paused
              ? <p className="muted">Agents are stopped.</p>
              : <ConfirmButton variant="danger" confirm="Stop every agent now" onConfirm={kill} disabled={busy}>Kill switch</ConfirmButton>}
            <a className="btn ghost" href="#/projects" onClick={() => setMenu(false)}>Projects</a>
            <Button variant="ghost" onClick={logout}>Log out</Button>
            <ErrorText error={error} />
          </div>
        )}
      </div>
    </header>
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
