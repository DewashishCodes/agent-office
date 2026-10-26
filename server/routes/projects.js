// Projects: create, settings, branches, onboarding, kill switch. Mounted by server/index.js behind the owner cookie check.
import express from 'express'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { all, get, insert, update, getProject, setTask, log } from '../db.js'
import { emit } from '../bus.js'
import { killProject, projectTokensToday, projectCostToday } from '../runner.js'
import { repoInfo, inspectFolder, initRepo, createRepoFromFolder, ensureClone, pullDefault, listBranches } from '../github.js'
import { startInterview, askOnboarding, applyProposal } from '../onboarding.js'
import { kick, resumeChecks } from '../scheduler.js'
import { supportAgent } from '../support.js'
import { fail, isObj, isStrs, str, background, project, count, regex } from '../http.js'

const app = express.Router()
export default app

// A bad value here (an invalid regex above all) would break every permission check, so each key is checked.
const SETTINGS = {
  protected_paths: isStrs,
  autonomy: count(1, 1),
  plan_approval_small: v => typeof v === 'boolean',
  github_issues: v => typeof v === 'boolean',
  digest_hour: v => v === null || count(0, 23)(v),
  project_daily_token_budget: count(0),
  project_daily_cost_budget: v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0),
  permission_timeout_min: count(1, 24 * 60),
  question_timeout_min: count(1, 24 * 60),
  auto_allow_bash: regex,
}

// Projects

app.get('/api/projects', (req, res) => res.json(all('SELECT * FROM projects ORDER BY id')))

// Folder browser for the new project wizard: the owner picks folders on this PC from the phone.
app.get('/api/fs/dirs', (req, res) => {
  const raw = req.query.path
  if (!raw) {
    const drives = process.platform === 'win32' ? [...'CDEFGHIJ'].map(d => `${d}:\\`).filter(d => existsSync(d)) : ['/']
    return res.json({ path: null, parent: null, dirs: [homedir(), ...drives] })
  }
  const path = resolve(String(raw))
  let dirs
  try { dirs = readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map(e => e.name) }
  catch { throw fail(400, `cannot open ${path}`) }
  const parent = dirname(path)
  res.json({ path, parent: parent === path ? null : parent, dirs: dirs.sort((a, b) => a.localeCompare(b)) })
})

const absPath = v => { if (typeof v !== 'string' || !isAbsolute(v)) throw fail(400, 'path must be an absolute folder path'); return resolve(v) }
const repoName = v => String(v || '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90)

app.post('/api/projects/inspect', async (req, res) => res.json(await inspectFolder(absPath(req.body?.path))))

// Three doors: a GitHub repo, an existing folder (a private repo is created from it when it has no GitHub remote, after
// the owner confirmed), or a blank folder with the owner's idea or PRD. The crew always works in its own clone.
app.post('/api/projects', async (req, res) => {
  const b = req.body ?? {}
  const source = b.source || 'github'
  let repo, source_path = null
  if (source === 'github') {
    repo = b.repo
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail(400, 'repo must be owner/name')
  } else if (source === 'local') {
    const info = await inspectFolder(absPath(b.path))
    if (!info.exists) throw fail(400, `${info.path} is not a folder`)
    source_path = info.path
    repo = info.repo
    if (!repo) {
      if (b.create_repo !== true) throw fail(400, 'This folder has no GitHub remote. Confirm creating a private repo for it.')
      if (!info.commits) await initRepo(info.path)
      repo = await createRepoFromFolder(info.path, repoName(b.name || info.name))
    }
  } else if (source === 'blank') {
    const name = str(b.name, 'name'), prd = str(b.prd, 'prd')
    const folder = repoName(b.folder || name)
    if (!folder) throw fail(400, 'folder name is required')
    source_path = join(absPath(b.parent), folder)
    if (existsSync(source_path) && readdirSync(source_path).length) throw fail(409, `${source_path} already exists and is not empty`)
    mkdirSync(source_path, { recursive: true })
    await initRepo(source_path, { 'docs/PRD.md': `${prd.trim()}\n`, 'README.md': `# ${name}\n\nSee docs/PRD.md.\n` })
    repo = await createRepoFromFolder(source_path, folder)
  } else throw fail(400, 'source must be github, local or blank')
  if (get('SELECT id FROM projects WHERE repo = ?', repo)) throw fail(409, `${repo} is already a project`)
  const info = await repoInfo(repo)
  const id = insert('projects', { name: b.name?.trim() || info.name, repo, default_branch: info.default_branch, source, source_path })
  supportAgent(id)
  background(id, startInterview(id))
  const p = getProject(id)
  emit('project', id, p)
  res.json(p)
})

app.get('/api/projects/:id', (req, res) => {
  const p = project(req)
  const kv = key => { const v = get('SELECT value FROM kv WHERE key = ?', key)?.value; return v ? JSON.parse(v) : null }
  res.json({
    ...p,
    running_runs: all("SELECT * FROM runs WHERE project_id = ? AND status = 'running' ORDER BY id", p.id),
    tokens_today: projectTokensToday(p.id),
    cost_today: projectCostToday(p.id),
    rate_limit: kv('rate_limit'),
    rate_limit_week: kv('rate_limit_week'),
  })
})

app.get('/api/projects/:id/branches', async (req, res) => {
  const p = project(req)
  await ensureClone(p)
  res.json({ current: p.default_branch, branches: await listBranches(getProject(p.id)) })
})

app.patch('/api/projects/:id', async (req, res) => {
  const p = project(req)
  const { name, settings, default_branch, ...rest } = req.body ?? {}
  if (Object.keys(rest).length) throw fail(400, `${Object.keys(rest)[0]} is not editable`)
  const f = {}
  if (name !== undefined) f.name = str(name, 'name')
  // The working branch: new tasks start from it, PRs target it and hotfixes push to it. Running tasks keep their base.
  if (default_branch !== undefined && default_branch !== p.default_branch) {
    await ensureClone(p)
    if (!(await listBranches(getProject(p.id))).includes(default_branch)) throw fail(400, `no branch ${default_branch} on GitHub`)
    await pullDefault({ ...getProject(p.id), default_branch })
    f.default_branch = default_branch
  }
  if (settings !== undefined) {
    if (!isObj(settings)) throw fail(400, 'settings must be an object')
    for (const [k, v] of Object.entries(settings)) {
      if (!SETTINGS[k]) throw fail(400, `${k} is not a setting`)
      if (!SETTINGS[k](v)) throw fail(400, `invalid ${k}`)
    }
    f.settings = { ...p.settings, ...settings }
  }
  update('projects', p.id, f)
  const out = getProject(p.id)
  emit('project', p.id, out)
  res.json(out)
})

// Re-run onboarding (also the retry after a failure): a new interview with the current office in the prompt.
app.post('/api/projects/:id/onboard', (req, res) => {
  const p = project(req)
  if (p.onboarding_status === 'running') throw fail(409, 'Onboarding is writing the crew docs right now')
  background(p.id, startInterview(p.id, { rerun: !['pending', 'failed'].includes(p.onboarding_status) || !!p.rerun }))
  res.status(202).json({ ok: true })
})

app.get('/api/projects/:id/onboarding', (req, res) => {
  const p = project(req)
  res.json({ messages: all(`SELECT * FROM messages WHERE project_id = ? AND channel = 'onboarding' ORDER BY id`, p.id), proposal: p.proposal, status: p.onboarding_status })
})

app.post('/api/projects/:id/onboarding', (req, res) => {
  const p = project(req)
  if (!['interviewing', 'proposed'].includes(p.onboarding_status)) throw fail(409, 'Onboarding is not in an interview. Re-run it first.')
  background(p.id, askOnboarding(p.id, str(req.body?.text, 'text')))
  res.status(202).json({ ok: true })
})

app.post('/api/projects/:id/onboarding/apply', (req, res) => {
  const p = project(req), keep = req.body?.keep ?? []
  if (!Array.isArray(keep) || !keep.every(Number.isInteger)) throw fail(400, 'keep must be a list of agent indexes')
  try { background(p.id, applyProposal(p.id, keep)) } catch (e) { throw fail(409, e.message) }
  res.status(202).json({ ok: true })
})

app.post('/api/projects/:id/kill', async (req, res) => {
  const p = project(req)
  update('projects', p.id, { paused: 1 })
  await killProject(p.id)
  for (const t of all("SELECT id FROM tasks WHERE project_id = ? AND status = 'in_progress'", p.id)) setTask(t.id, { status: 'planned' })
  log(p.id, 'kill', 'Kill switch: all agents stopped, project paused')
  emit('project', p.id, getProject(p.id))
  res.json({ ok: true })
})

app.post('/api/projects/:id/resume', (req, res) => {
  const p = project(req)
  update('projects', p.id, { paused: 0 })
  log(p.id, 'resume', 'Project resumed')
  emit('project', p.id, getProject(p.id))
  resumeChecks(p.id)
  kick()
  res.json({ ok: true })
})
