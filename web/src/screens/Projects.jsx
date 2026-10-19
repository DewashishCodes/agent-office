import { useState } from 'react'
import { api } from '../api.js'
import { Badge, Button, Empty, ErrorText, ghUrl, useAction } from '../ui.jsx'

const ONBOARDING = {
  pending: 'Waiting to start onboarding',
  running: 'Onboarding: the Orchestrator is reading the repo',
  pr_open: 'Onboarding PR is open. Merge it to finish setup.',
  done: 'Ready',
  failed: 'Onboarding failed',
}

export default function Projects({ projects, current, reload, onPick }) {
  const [repo, setRepo] = useState('')
  const [run, busy, error] = useAction()
  const add = e => {
    e.preventDefault()
    run(async () => {
      const p = await api('/projects', { method: 'POST', body: { repo: repo.trim() } })
      setRepo('')
      await reload()
      onPick(p.id)
    })
  }
  return (
    <section className="page stack">
      <h1>Projects</h1>
      <form className="card stack" onSubmit={add}>
        <label className="field">
          <span>GitHub repository</span>
          <input placeholder="owner/repo" value={repo} onChange={e => setRepo(e.target.value)} required
            autoCapitalize="off" autoCorrect="off" spellCheck="false" />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Adding' : 'Add project'}</Button>
        <p className="muted small">The crew clones the repo, then opens an onboarding PR with CLAUDE.md and agent paths.</p>
        <ErrorText error={error} />
      </form>
      {projects.length === 0 ? <Empty>No projects yet.</Empty> : (
        <ul className="list">
          {projects.map(p => <ProjectRow key={p.id} p={p} current={p.id === current} onPick={onPick} />)}
        </ul>
      )}
    </section>
  )
}

function ProjectRow({ p, current, onPick }) {
  const [run, busy, error] = useAction()
  return (
    <li className="card row-card">
      <div className="grow">
        <div className="title">{p.repo} {current && <span className="muted small">(current)</span>}</div>
        <div className="muted small">
          <Badge status={p.onboarding_status}>{p.onboarding_status.replace('_', ' ')}</Badge> {ONBOARDING[p.onboarding_status]}
          {p.onboarding_pr && <> <a href={ghUrl(p.repo, 'pull', p.onboarding_pr)} target="_blank" rel="noreferrer">PR #{p.onboarding_pr}</a></>}
        </div>
        <ErrorText error={error} />
      </div>
      <div className="actions">
        {p.onboarding_status === 'failed' && (
          <Button small disabled={busy} onClick={() => run(() => api(`/projects/${p.id}/onboard`, { method: 'POST' }))}>Run onboarding</Button>
        )}
        <Button small variant={current ? 'default' : 'primary'} onClick={() => onPick(p.id)}>Open</Button>
      </div>
    </li>
  )
}
