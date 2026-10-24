import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
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

export async function closePR(project, number) {
  await gh('pr', 'close', String(number), '-R', project.repo, '--comment', 'Canceled by the owner in Agent Office.', '--delete-branch')
}

export async function mergePR(project, number) {
  await gh('pr', 'merge', String(number), '-R', project.repo, '--squash', '--delete-branch')
}

// MERGEABLE, CONFLICTING or UNKNOWN (GitHub still computing).
export async function prMergeable(project, number) {
  return JSON.parse(await gh('pr', 'view', String(number), '-R', project.repo, '--json', 'mergeable')).mergeable
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

// pass | fail | pending | none from a PR's statusCheckRollup.
function checksState(checks = []) {
  // CheckRun has status/conclusion, StatusContext has state.
  const results = checks.map(c => c.conclusion || c.state || '')
  let state = 'none'
  if (checks.length) {
    if (results.some(x => FAILED.includes(x))) state = 'fail'
    else if (checks.some(c => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED', ''].includes(c.conclusion || c.state || ''))) state = 'pending'
    else state = 'pass'
  }
  return state
}

export async function prState(project, number) {
  const r = JSON.parse(await gh('pr', 'view', String(number), '-R', project.repo, '--json', 'state,statusCheckRollup'))
  return { state: r.state, checks: checksState(r.statusCheckRollup || []) }
}

// The project's latest PRs in one call, number -> { state, checks }; older ones need prState.
export async function prStates(project) {
  const list = JSON.parse(await gh('pr', 'list', '-R', project.repo, '--state', 'all', '--limit', '100', '--json', 'number,state,statusCheckRollup'))
  return new Map(list.map(r => [r.number, { state: r.state, checks: checksState(r.statusCheckRollup || []) }]))
}

export async function prDiff(project, number) {
  return (await exec('gh', ['pr', 'diff', String(number), '-R', project.repo])).slice(0, 200000)
}

export const ensureClone = serial(ensureCloneNow)
export const pullDefault = serial(pullDefaultNow)
export const createWorktree = serial(createWorktreeNow)
export const removeWorktree = serial(removeWorktreeNow)
export const pushBranch = serial(pushBranchNow)

// Owner folders: the crew never works in them. It reads what is there, and for a folder with no GitHub remote creates a
// private repo from it; after that the crew works in its own clone like any GitHub project.

export const parseRemote = url => /github\.com[:/]([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/.exec(String(url || '').trim())?.slice(1, 3).join('/') ?? null

const SECRET = /^(\.env(\..+)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|credentials\.json|service-account.*\.json)$/i
const SAFE = /^\.env\.(example|sample|template)$/i
const isSecret = name => SECRET.test(name) && !SAFE.test(name)
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next'])

// File count and secret-looking names under dir, capped so a huge folder does not stall the request.
function walk(dir, out = { files: 0, secrets: [] }, rel = '') {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (out.files > 20000) break
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name), out, r) }
    else { out.files++; if (isSecret(e.name)) out.secrets.push(r) }
  }
  return out
}

export async function inspectFolder(path) {
  const abs = resolve(String(path || ''))
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { path: abs, exists: false }
  const isGit = existsSync(join(abs, '.git'))
  const info = { path: abs, exists: true, name: basename(abs), git: isGit, repo: null, commits: false, dirty: 0, files: 0, secrets: [] }
  if (isGit) {
    info.repo = parseRemote(await git(abs, 'remote', 'get-url', 'origin').catch(() => ''))
    info.commits = await git(abs, 'rev-parse', '--verify', '--quiet', 'HEAD').then(() => true, () => false)
    info.dirty = (await git(abs, 'status', '--porcelain')).split('\n').filter(Boolean).length
    const tracked = (await git(abs, 'ls-files')).split('\n').filter(Boolean)
    info.files = tracked.length
    // Already committed secrets would go to GitHub with the history; the owner has to see that.
    info.secrets = tracked.filter(f => isSecret(f.split('/').pop()))
  } else Object.assign(info, walk(abs))
  return info
}

const IGNORE = ['.env', '.env.*', '!.env.example', '*.pem', '*.key', 'node_modules/', '.DS_Store']

// A first commit for a folder that has none: default ignores go in first so secrets and dependencies stay out.
export async function initRepo(path, files = {}) {
  for (const [rel, text] of Object.entries(files)) {
    const f = join(path, rel)
    if (existsSync(f)) continue
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, text)
  }
  const gi = join(path, '.gitignore')
  const have = existsSync(gi) ? readFileSync(gi, 'utf8').split(/\r?\n/) : []
  const missing = IGNORE.filter(l => !have.includes(l))
  if (missing.length) appendFileSync(gi, `${have.length && have.at(-1) !== '' ? '\n' : ''}${missing.join('\n')}\n`)
  if (!existsSync(join(path, '.git'))) await git(path, 'init', '-b', 'main')
  await git(path, 'add', '-A')
  await git(path, 'commit', '-m', 'Initial commit')
}

export const ghLogin = () => gh('api', 'user', '--jq', '.login')

// Creates a private GitHub repo from the folder, sets it as origin and pushes the current branch. Returns "owner/name".
export async function createRepoFromFolder(path, name) {
  const out = await exec('gh', ['repo', 'create', name, '--private', '--source', path, '--remote', 'origin', '--push'], path)
  return parseRemote(out.split('\n').find(l => l.includes('github.com'))) || `${await ghLogin()}/${name}`
}

// Squash merges rewrite a dependency's commits, so a stacked branch keeps only its own (base_sha..branch) on top of the
// default branch. Returns the new base. A conflict aborts the rebase and leaves the branch as it was.
async function restackNow(path, base_sha, branch, default_branch) {
  await git(path, 'fetch', 'origin')
  try { await git(path, 'rebase', '--onto', `origin/${default_branch}`, base_sha, branch) } catch (e) {
    await git(path, 'rebase', '--abort').catch(() => {})
    throw new Error(`Rebasing ${branch} onto ${default_branch} conflicted, so it needs a manual merge: ${e.message}`)
  }
  await git(path, 'push', '--force-with-lease', 'origin', branch)
  return git(path, 'rev-parse', `origin/${default_branch}`)
}
export const restack = serial(restackNow)

// Hotfix: the task's own commits (base_sha..branch) go on top of the project branch so the push is a fast-forward.
// Returns the new base. Like restack, but the task branch itself is never pushed.
async function rebaseOntoNow(path, base_sha, branch, target) {
  await git(path, 'fetch', 'origin')
  try { await git(path, 'rebase', '--onto', `origin/${target}`, base_sha, branch) } catch (e) {
    await git(path, 'rebase', '--abort').catch(() => {})
    throw new Error(`Rebasing the hotfix onto ${target} conflicted: ${e.message}`)
  }
  return git(path, 'rev-parse', `origin/${target}`)
}
export const rebaseOnto = serial(rebaseOntoNow)

export async function listBranches(project) {
  const out = await git(clonePath(project), 'ls-remote', '--heads', 'origin')
  return out.split('\n').map(l => l.split('refs/heads/')[1]).filter(Boolean).sort()
}

async function pushToNow(path, ref) {
  await git(path, 'push', 'origin', ref)
}
export const pushTo = serial(pushToNow)
