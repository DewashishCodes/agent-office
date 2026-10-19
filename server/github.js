import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DATA_DIR, update } from './db.js'

function exec(cmd, args, cwd) {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) fail(new Error(`${cmd} ${args[0]} failed: ${(stderr || err.message).trim()}`))
      else ok(stdout)
    })
  })
}

// Git ops on a shared clone (fetch, worktree add, push) race on its lock files, so they run one at a time.
let gitQueue = Promise.resolve()
const serial = fn => (...a) => {
  const p = gitQueue.then(() => fn(...a))
  gitQueue = p.catch(() => {})
  return p
}

const git = (cwd, ...args) => exec('git', args, cwd).then(s => s.trim())
const gh = (...args) => exec('gh', args).then(s => s.trim())

const repoDir = project => join(DATA_DIR, 'repos', project.repo.replace('/', '__'))
const clonePath = project => project.local_path || repoDir(project)

export async function repoInfo(repo) {
  const r = JSON.parse(await gh('repo', 'view', repo, '--json', 'defaultBranchRef,name'))
  return { default_branch: r.defaultBranchRef?.name || 'main', name: r.name }
}

async function ensureCloneNow(project) {
  const dir = repoDir(project)
  if (existsSync(join(dir, '.git'))) await git(dir, 'fetch', 'origin')
  else {
    mkdirSync(join(DATA_DIR, 'repos'), { recursive: true })
    await gh('repo', 'clone', project.repo, dir)
  }
  if (project.local_path !== dir) update('projects', project.id, { local_path: dir })
  project.local_path = dir
  return dir
}

async function pullDefaultNow(project) {
  const dir = clonePath(project), b = project.default_branch
  await git(dir, 'fetch', 'origin')
  await git(dir, 'checkout', b)
  await git(dir, 'merge', '--ff-only', `origin/${b}`)
}

async function createWorktreeNow(project, branch, { from } = {}) {
  const repo = clonePath(project)
  const path = resolve(DATA_DIR, 'worktrees', String(project.id), branch.replaceAll('/', '-'))
  await git(repo, 'worktree', 'prune')
  if (!existsSync(path)) {
    mkdirSync(join(DATA_DIR, 'worktrees', String(project.id)), { recursive: true })
    const exists = await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false)
    if (exists) await git(repo, 'worktree', 'add', path, branch)
    else {
      await git(repo, 'fetch', 'origin')
      await git(repo, 'worktree', 'add', '-b', branch, path, from || `origin/${project.default_branch}`)
    }
  }
  return { path, base_sha: await git(path, 'rev-parse', 'HEAD') }
}

export async function mergeIntoWorktree(path, refs = []) {
  for (const ref of refs) {
    try { await git(path, 'merge', '--no-edit', ref) } catch (e) {
      await git(path, 'merge', '--abort').catch(() => {})
      throw new Error(`Merge of ${ref} conflicted: ${e.message}`)
    }
  }
}

async function removeWorktreeNow(project, path) {
  await git(clonePath(project), 'worktree', 'remove', '--force', path)
}

export async function commitAll(path, message) {
  await git(path, 'add', '-A')
  if (!(await git(path, 'status', '--porcelain'))) return false
  await git(path, 'commit', '-m', message)
  return true
}

export async function changedFiles(path, base_sha) {
  const out = await git(path, 'diff', '--name-only', `${base_sha}..HEAD`)
  return out ? out.split('\n').map(f => f.trim().replaceAll('\\', '/')).filter(Boolean) : []
}

async function pushBranchNow(path, branch) {
  await git(path, 'push', '-u', 'origin', branch)
}

const numberFromUrl = url => Number(url.trim().split('/').pop())

export async function createIssue(project, { title, body }) {
  return numberFromUrl(await gh('issue', 'create', '-R', project.repo, '--title', title, '--body', body || ''))
}

// Labels made this process; --force makes creation idempotent across restarts.
const madeLabels = new Set()

export async function setIssueStatus(project, issue_number, status) {
  const label = `crew:${status}`
  if (!madeLabels.has(project.repo + label)) {
    await gh('label', 'create', label, '-R', project.repo, '--force', '--color', 'BFD4F2')
    madeLabels.add(project.repo + label)
  }
  const { labels } = JSON.parse(await gh('issue', 'view', String(issue_number), '-R', project.repo, '--json', 'labels'))
  const stale = labels.map(l => l.name).filter(n => n.startsWith('crew:') && n !== label)
  const args = ['issue', 'edit', String(issue_number), '-R', project.repo, '--add-label', label]
  if (stale.length) args.push('--remove-label', stale.join(','))
  await gh(...args)
}

export async function createPR(project, { branch, title, body }) {
  const url = await gh('pr', 'create', '-R', project.repo, '--head', branch, '--base', project.default_branch, '--title', title, '--body', body || '')
  return { number: numberFromUrl(url), url: url.trim().split('\n').pop() }
}

export async function prComment(project, number, body) {
  await gh('pr', 'comment', String(number), '-R', project.repo, '--body', body)
}

export async function mergePR(project, number) {
  await gh('pr', 'merge', String(number), '-R', project.repo, '--squash', '--delete-branch')
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

export async function prState(project, number) {
  const r = JSON.parse(await gh('pr', 'view', String(number), '-R', project.repo, '--json', 'state,statusCheckRollup'))
  const checks = r.statusCheckRollup || []
  // CheckRun has status/conclusion, StatusContext has state.
  const results = checks.map(c => c.conclusion || c.state || '')
  let state = 'none'
  if (checks.length) {
    if (results.some(x => FAILED.includes(x))) state = 'fail'
    else if (checks.some(c => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED', ''].includes(c.conclusion || c.state || ''))) state = 'pending'
    else state = 'pass'
  }
  return { state: r.state, checks: state }
}

export async function prDiff(project, number) {
  return (await exec('gh', ['pr', 'diff', String(number), '-R', project.repo])).slice(0, 200000)
}

export const ensureClone = serial(ensureCloneNow)
export const pullDefault = serial(pullDefaultNow)
export const createWorktree = serial(createWorktreeNow)
export const removeWorktree = serial(removeWorktreeNow)
export const pushBranch = serial(pushBranchNow)
