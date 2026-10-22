import { useState } from 'react'
import { api } from '../api.js'
import { Badge, Button, Empty, ErrorText, ghUrl, useAction } from '../ui.jsx'
import FolderPicker from '../components/FolderPicker.jsx'

const ONBOARDING = {
  pending: 'Waiting to start onboarding',
  interviewing: 'Onboarding: the interview is going on',
  proposed: 'Onboarding: an office proposal waits for you',
  running: 'Onboarding: writing CLAUDE.md, the playbook and the brief',
  pr_open: 'Onboarding PR is open. Merge it to finish setup.',
  done: 'Ready',
  failed: 'Onboarding failed',
}

const DOORS = [
  ['local', 'Existing folder', 'A project already on this PC. The crew reads it and works in its own copy.'],
  ['blank', 'Start blank', 'A new folder from your idea or PRD. The crew proposes the office and the first build.'],
  ['github', 'GitHub repo', 'A repo that is already on GitHub, by owner/name.'],
]

export default function Projects({ projects, current, reload, onPick }) {
  const [door, setDoor] = useState(null)
  const created = async p => { await reload(); onPick(p.id, '#/onboarding') }
  return (
    <section className="page stack">
      <h1>Projects</h1>
      <div className="card stack">
        <h2>New project</h2>
        <div className="doors" role="radiogroup" aria-label="How the project starts">
          {DOORS.map(([k, title, text]) => (
            <button key={k} type="button" role="radio" aria-checked={door === k} className={`door ${door === k ? 'on' : ''}`} onClick={() => setDoor(k)}>
              <span className="title">{title}</span><span className="muted small">{text}</span>
            </button>
          ))}
        </div>
        {door === 'github' && <FromGithub onCreated={created} />}
        {door === 'local' && <FromFolder onCreated={created} />}
        {door === 'blank' && <FromBlank onCreated={created} />}
      </div>
      {projects.length === 0 ? <Empty>No projects yet.</Empty> : (
        <ul className="list">
          {projects.map(p => <ProjectRow key={p.id} p={p} current={p.id === current} onPick={onPick} />)}
        </ul>
      )}
    </section>
  )
}

const create = body => api('/projects', { method: 'POST', body })

function FromGithub({ onCreated }) {
  const [repo, setRepo] = useState('')
  const [run, busy, error] = useAction()
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); run(async () => onCreated(await create({ source: 'github', repo: repo.trim() }))) }}>
      <label className="field"><span>GitHub repository</span>
        <input placeholder="owner/repo" value={repo} onChange={e => setRepo(e.target.value)} required autoCapitalize="off" autoCorrect="off" spellCheck="false" />
      </label>
      <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Adding' : 'Add and start onboarding'}</Button>
      <ErrorText error={error} />
    </form>
  )
}

function FromFolder({ onCreated }) {
  const [path, setPath] = useState(null)
  const [info, setInfo] = useState(null)
  const [run, busy, error] = useAction()
  const pick = p => { setPath(p); setInfo(null) }
  const inspect = () => run(async () => setInfo(await api('/projects/inspect', { method: 'POST', body: { path } })))
  const go = create_repo => run(async () => onCreated(await create({ source: 'local', path, create_repo })))
  return (
    <div className="stack">
      <FolderPicker path={path} onPath={pick} />
      {path && !info && <Button variant="primary" disabled={busy} onClick={inspect}>{busy ? 'Checking' : 'Use this folder'}</Button>}
      {info && (
        <div className="card stack inspect">
          <p className="mono small">{info.path}</p>
          {info.repo
            ? <p>On GitHub as <b>{info.repo}</b>. The crew clones it and works in its own copy.</p>
            : <p>No GitHub remote{info.git ? '' : ' and no git yet'}. The crew needs one: it will create the <b>private</b> repo <b>{info.name}</b> on your GitHub account and push {info.git ? 'the committed history' : `${info.files} files`}.</p>}
          {info.dirty > 0 && <p className="warn small">{info.dirty} uncommitted change{info.dirty === 1 ? '' : 's'} will not be included. Commit them first if the crew should see them.</p>}
          {info.secrets.length > 0 && (info.git
            ? <p className="error">Already committed, and would go to GitHub with the history: {info.secrets.join(', ')}. Remove them from git first.</p>
            : <p className="small">Kept out by a .gitignore: {info.secrets.join(', ')}</p>)}
          <div className="actions">
            {info.repo
              ? <Button variant="primary" disabled={busy} onClick={() => go(false)}>{busy ? 'Adding' : 'Add and start onboarding'}</Button>
              : <Button variant="primary" disabled={busy || (info.git && info.secrets.length > 0)} onClick={() => go(true)}>{busy ? 'Creating the repo' : 'Create private repo and start'}</Button>}
            <Button variant="ghost" onClick={() => setInfo(null)}>Back</Button>
          </div>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  )
}

function FromBlank({ onCreated }) {
  const [parent, setParent] = useState(null)
  const [name, setName] = useState('')
  const [prd, setPrd] = useState('')
  const [run, busy, error] = useAction()
  const folder = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  const load = e => { const f = e.target.files?.[0]; if (f) f.text().then(setPrd) }
  const go = e => { e.preventDefault(); run(async () => onCreated(await create({ source: 'blank', parent, folder, name: name.trim(), prd }))) }
  return (
    <form className="stack" onSubmit={go}>
      <div className="field"><span>Where to create it</span><FolderPicker path={parent} onPath={setParent} /></div>
      <label className="field"><span>Project name</span><input value={name} onChange={e => setName(e.target.value)} required placeholder="Habit tracker" /></label>
      {parent && folder && <p className="muted small mono">{parent.replace(/[\\/]+$/, '')}{parent.includes('\\') ? '\\' : '/'}{folder}</p>}
      <label className="field"><span>Your idea or PRD</span>
        <textarea rows="8" value={prd} onChange={e => setPrd(e.target.value)} required placeholder="What you want to build, for whom, and what matters most. Paste a PRD if you have one." />
      </label>
      <label className="btn small upload">Load a .md or .txt file<input type="file" accept=".md,.txt,text/markdown,text/plain" onChange={load} /></label>
      <p className="muted small">Creates the folder, a git repo with your PRD in docs/PRD.md, and a private GitHub repo of the same name.</p>
      <Button type="submit" variant="primary" disabled={busy || !parent || !folder || !prd.trim()}>{busy ? 'Creating' : 'Create and start onboarding'}</Button>
      <ErrorText error={error} />
    </form>
  )
}

function ProjectRow({ p, current, onPick }) {
  const [run, busy, error] = useAction()
  const rerun = () => run(async () => { await api(`/projects/${p.id}/onboard`, { method: 'POST' }); onPick(p.id, '#/onboarding') })
  const live = ['interviewing', 'proposed', 'running'].includes(p.onboarding_status)
  return (
    <li className="card row-card">
      <div className="grow">
        <div className="title">{p.name || p.repo} {current && <span className="muted small">(current)</span>}</div>
        <div className="muted small mono">{p.repo}{p.source_path ? `, ${p.source_path}` : ''}</div>
        <div className="muted small">
          <Badge status={p.onboarding_status}>{p.onboarding_status.replace('_', ' ')}</Badge> {ONBOARDING[p.onboarding_status]}
          {p.onboarding_pr && <> <a href={ghUrl(p.repo, 'pull', p.onboarding_pr)} target="_blank" rel="noreferrer">PR #{p.onboarding_pr}</a></>}
        </div>
        <ErrorText error={error} />
      </div>
      <div className="actions">
        {live
          ? <Button small onClick={() => onPick(p.id, '#/onboarding')}>Continue onboarding</Button>
          : <Button small disabled={busy} onClick={rerun}>{p.onboarding_status === 'failed' ? 'Retry onboarding' : 'Re-run onboarding'}</Button>}
        <Button small variant={current ? 'default' : 'primary'} onClick={() => onPick(p.id)}>Open</Button>
      </div>
    </li>
  )
}
