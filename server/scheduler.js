import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { all, get, run, update, getProject, getAgent, getTask, getOrder, activeAgents, setTask, setAgent, setOrder, log, addInbox, resolveInbox, now } from './db.js'
import { emit } from './bus.js'
import { runClaude, tokensToday, projectTokensToday, runningCount } from './runner.js'
import { ensureClone, createWorktree, mergeIntoWorktree, commitAll, changedFiles, pushBranch, createPR, prComment, setIssueStatus, prState } from './github.js'
import { checkTask } from './pipeline.js'
import { integrateOrder } from './orchestrator.js'
import { matchAgent, readyTasks, isAllowed } from './rules.js'

export { matchAgent, readyTasks, isAllowed }

export const TASK_DISALLOWED = ['Bash(git push*)', 'Bash(gh *)', 'Read(.env*)', 'Read(**/.env*)']
export const MAX_ATTEMPTS = 2

const pexec = promisify(execFile)
export const git = async (cwd, ...args) => (await pexec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout.trim()

const today = () => new Date().toLocaleDateString('sv')

// True the first time per local day for this key, so budget warnings do not repeat every tick.
function oncePerDay(key) {
  if (get('SELECT value FROM kv WHERE key = ?', key)?.value === today()) return false
  run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, today())
  return true
}

// GitHub labels are cosmetic; a failed label call must not fail the task.
export async function issueStatus(project, task, status) {
  if (!task.issue_number) return
  try { await setIssueStatus(project, task.issue_number, status) } catch (e) { log(project.id, 'error', `Issue label failed for #${task.issue_number}: ${e.message}`, { task_id: task.id }) }
}

export async function comment(project, task, body) {
  if (!task.pr_number) return
  try { await prComment(project, task.pr_number, body) } catch (e) { log(project.id, 'error', `PR comment failed on #${task.pr_number}: ${e.message}`, { task_id: task.id }) }
}

// One failure path for gate, session, Reviewer and QA failures.
export function failTask(task_id, notes) {
  const t = getTask(task_id)
  const attempts = t.attempts + 1
  const blocked = attempts >= MAX_ATTEMPTS
  setTask(task_id, { attempts, notes, status: blocked ? 'blocked' : 'planned' })
  const extra = { task_id, agent_id: t.agent_id, order_id: t.order_id, link: t.pr_url }
  log(t.project_id, 'failure', `${blocked ? 'Blocked' : 'Retrying'} "${t.title}" (attempt ${attempts}): ${notes.slice(0, 300)}`, extra)
  if (blocked) {
    addInbox(t.project_id, 'failure', `Task failed twice: ${t.title}`, { body: notes, link: t.pr_url, order_id: t.order_id, task_id })
    issueStatus(getProject(t.project_id), t, 'blocked')
  }
  kick()
}

const readOpt = p => readFile(p, 'utf8').catch(() => '')

const SYSTEM_TASK = (a, t, project) => `You are ${a.name}, the ${a.role} developer on an AI dev crew working on the GitHub repo ${project.repo}. ${a.specialty}

${a.instructions}

Rules, no exceptions:
- Read CLAUDE.md and .crew/PLAYBOOK.md in the repo root first (copies are in the prompt). Follow their conventions, commands and definition of done.
- You may create, edit or delete only files matching your owned paths: ${a.owned_paths.join(', ')}
- Never touch protected paths, even if they look owned: ${project.settings.protected_paths.join(', ')}
- Everything else is read-only for you. Any edit outside your owned paths fails the task automatically.
- Work only in the current directory, on the current branch ${t.branch}. Do not switch, create or rebase branches.
- When done, commit with git (git add, git commit) and a clear message. Never push, never run gh, never open a PR: the crew does that for you.
- Never read, print or copy .env files or secrets.
- Run the relevant tests and build from CLAUDE.md before you finish, and fix what you broke.
- If the task needs a change outside your paths, do your part and say exactly what is missing in your final message.
- End with a short summary: what you changed, how you tested it, anything left open.`

async function taskPrompt(t, a) {
  const [claude, playbook] = await Promise.all([readOpt(join(t.worktree, 'CLAUDE.md')), readOpt(join(t.worktree, '.crew', 'PLAYBOOK.md'))])
  const notes = all('SELECT text FROM agent_notes WHERE agent_id = ? ORDER BY id', a.id).map(n => `- ${n.text}`).join('\n')
  const deps = t.depends_on.map(getTask).filter(Boolean)
  return [
    claude && `# CLAUDE.md\n\n${claude}`,
    playbook && `# .crew/PLAYBOOK.md\n\n${playbook}`,
    notes && `# Notes from the owner for you\n\n${notes}`,
    `# Your task: ${t.title}\n\n${t.description}`,
    `## Acceptance criteria\n\n${t.acceptance.map(c => `- ${c}`).join('\n') || '- (none given, use the description)'}`,
    t.files.length && `## Files you are expected to touch\n\n${t.files.join('\n')}`,
    deps.length && `## Already merged into your branch\n\n${deps.map(d => `- ${d.title} (${d.branch})`).join('\n')}`,
    t.attempts && t.notes && `## Previous attempt failed (attempt ${t.attempts + 1} now)\n\nYour earlier work is already on this branch. Fix these points:\n\n${t.notes}`,
  ].filter(Boolean).join('\n\n')
}

function prBody(t) {
  const order = getOrder(t.order_id)
  const deps = t.depends_on.map(getTask).filter(d => d?.pr_number && !d.merged)
  return [
    order?.plan?.summary && `Part of: ${order.plan.summary}`,
    t.description,
    `### Acceptance\n${t.acceptance.map(c => `- [ ] ${c}`).join('\n')}`,
    deps.length && `### Merge first\n${deps.map(d => `- #${d.pr_number} ${d.title}`).join('\n')}`,
    t.issue_number && `Closes #${t.issue_number}`,
    '_Opened by Agent Crew._',
  ].filter(Boolean).join('\n\n')
}

async function runTask(task_id) {
  let t = getTask(task_id)
  const project = getProject(t.project_id)
  const agent = getAgent(t.agent_id)
  const branch = t.branch || `crew/t${t.id}`
  // Fresh fetch on the first attempt so the branch starts from the current default.
  if (!t.worktree) await ensureClone(project)
  const wt = await createWorktree(project, branch)
  const depBranches = t.depends_on.map(getTask).filter(d => d?.branch && !d.merged).map(d => d.branch)
  if (depBranches.length) await mergeIntoWorktree(wt.path, depBranches)
  // Retries keep the first base so the gate and Reviewer see the whole branch.
  const base_sha = t.base_sha || await git(wt.path, 'rev-parse', 'HEAD')
  t = setTask(task_id, { branch, worktree: wt.path, base_sha })
  log(project.id, 'dispatch', `${agent.name} started "${t.title}"${t.attempts ? ` (attempt ${t.attempts + 1})` : ''}`, { task_id, agent_id: agent.id, order_id: t.order_id })
  issueStatus(project, t, 'in_progress')

  const r = await runClaude({
    project_id: project.id, agent_id: agent.id, task_id, kind: 'task', cwd: wt.path,
    prompt: await taskPrompt(t, agent), systemPrompt: SYSTEM_TASK(agent, t, project),
    model: agent.model, effort: agent.effort, permissionMode: 'bypassPermissions', disallowedTools: TASK_DISALLOWED,
  })
  // Kill switch already put the task back to planned; do not count it as an attempt.
  if (getProject(project.id).paused) return
  if (!r.ok) return failTask(task_id, `The session crashed: ${String(r.text).slice(0, 2000)}`)

  await commitAll(wt.path, `${t.title} (crew task ${t.id})`)
  const files = await changedFiles(wt.path, base_sha)
  if (!files.length) return failTask(task_id, 'No files changed. Make the change and commit it.')
  const bad = files.filter(f => !isAllowed(f, agent.owned_paths, project.settings.protected_paths))
  if (bad.length) {
    log(project.id, 'gate', `Gate rejected "${t.title}": ${bad.join(', ')}`, { task_id, agent_id: agent.id })
    return failTask(task_id, `These files are outside your owned paths or inside protected paths. Revert every change to them (git checkout ${base_sha} -- <file>, or git rm for new files) and commit:\n${bad.map(f => `- ${f}`).join('\n')}`)
  }

  await pushBranch(wt.path, branch)
  if (!t.pr_number) {
    const pr = await createPR(project, { branch, title: t.title, body: prBody(t) })
    t = setTask(task_id, { pr_number: pr.number, pr_url: pr.url })
  } else await comment(project, t, `Attempt ${t.attempts + 1} pushed, addressing:\n\n${t.notes}`)
  t = setTask(task_id, { status: 'in_review' })
  issueStatus(project, t, 'in_review')
  log(project.id, 'pr', `${agent.name} opened PR #${t.pr_number} for "${t.title}"`, { task_id, agent_id: agent.id, order_id: t.order_id, link: t.pr_url })
  await checkTask(task_id)
}

// One task's pipeline failing must never take down the loop.
async function runTaskSafe(task_id) {
  try { await runTask(task_id) } catch (e) {
    const t = getTask(task_id)
    log(t.project_id, 'error', `"${t.title}": ${e.message}`, { task_id, agent_id: t.agent_id, order_id: t.order_id })
    if (getProject(t.project_id).paused) return
    failTask(task_id, `Error: ${e.message}`)
  }
}

const busy = a => Math.max(runningCount(a.id), get(`SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'in_progress'`, a.id).n)

function tickProject(p) {
  if (projectTokensToday(p.id) >= p.settings.project_daily_token_budget) {
    if (oncePerDay(`budget:p${p.id}`)) {
      log(p.id, 'budget', 'Project daily token budget reached; no new tasks start until tomorrow.')
      addInbox(p.id, 'question', 'Project daily token budget reached', { body: 'Raise project_daily_token_budget in settings or wait until tomorrow.' })
    }
    return
  }
  const tasks = all(`SELECT t.* FROM tasks t JOIN orders o ON o.id = t.order_id WHERE t.project_id = ? AND o.status = 'in_progress' ORDER BY t.id`, p.id)
  const agents = activeAgents(p.id)
  for (const t of readyTasks(tasks)) {
    let a = agents.find(x => x.id === t.agent_id)
    if (!a || a.status === 'paused') {
      const pick = matchAgent(agents, t)
      // A paused owner with no stand-in waits; it is not a failure.
      if (!pick && a) continue
      if (!pick) {
        const files = t.files.join(', ') || '(no files listed)'
        setTask(t.id, { status: 'blocked', agent_id: null, notes: `No agent covers ${files}` })
        addInbox(p.id, 'question', `No agent covers ${files}`, { body: `Task "${t.title}" (role ${t.role}) needs an agent whose owned paths cover ${files}. Add or edit an agent, then retry the task.`, order_id: t.order_id, task_id: t.id })
        log(p.id, 'blocked', `No agent covers "${t.title}"`, { task_id: t.id, order_id: t.order_id })
        continue
      }
      a = pick
    }
    if (busy(a) >= a.max_parallel) continue
    if (tokensToday(a.id) >= a.daily_token_budget) {
      if (oncePerDay(`budget:a${a.id}`)) {
        log(p.id, 'budget', `${a.name} reached its daily token budget`, { agent_id: a.id })
        addInbox(p.id, 'question', `${a.name} reached its daily token budget`, { body: 'Raise the budget on the agent profile or wait until tomorrow.' })
      }
      continue
    }
    // Synchronous claim before any await: the next tick or loop pass cannot pick it again.
    setTask(t.id, { status: 'in_progress', agent_id: a.id })
    runTaskSafe(t.id)
  }
}

// Fully synchronous (DB and runner counters are sync), so ticks can never overlap.
function tick() {
  for (const p of all('SELECT * FROM projects WHERE paused = 0')) {
    try { tickProject(p) } catch (e) { console.error('scheduler tick', p.id, e) }
  }
}

let kickTimer = null
export function kick() {
  if (kickTimer) return
  kickTimer = setTimeout(() => { kickTimer = null; tick() }, 200)
}

// Shared by the PR poll and the Inbox merge action; idempotent so a merge seen by both is handled once.
export function markMerged(task_id) {
  const t = getTask(task_id)
  if (t.merged) return
  setTask(t.id, { merged: 1 })
  log(t.project_id, 'merge', `PR #${t.pr_number} merged: ${t.title}`, { task_id: t.id, order_id: t.order_id, link: t.pr_url })
  for (const i of all(`SELECT id FROM inbox WHERE task_id = ? AND kind = 'merge' AND status = 'open'`, t.id)) resolveInbox(i.id)
  const left = get('SELECT COUNT(*) AS n FROM tasks WHERE order_id = ? AND merged = 0', t.order_id).n
  if (!left && getOrder(t.order_id).status !== 'done') {
    setOrder(t.order_id, { status: 'done' })
    log(t.project_id, 'order', 'Order done: every PR merged', { order_id: t.order_id })
  }
}

export function markOnboarded(project_id) {
  const p = getProject(project_id)
  if (p.onboarding_status === 'done') return
  update('projects', p.id, { onboarding_status: 'done' })
  emit('project', p.id, getProject(p.id))
  log(p.id, 'merge', `Onboarding PR #${p.onboarding_pr} merged`)
  for (const i of all(`SELECT id FROM inbox WHERE project_id = ? AND kind = 'merge' AND task_id IS NULL AND order_id IS NULL AND status = 'open'`, p.id)) resolveInbox(i.id)
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    for (const t of all('SELECT * FROM tasks WHERE pr_number IS NOT NULL AND merged = 0')) {
      try {
        if ((await prState(getProject(t.project_id), t.pr_number)).state === 'MERGED') markMerged(t.id)
      } catch (e) { console.error('pr poll', t.id, e.message) }
    }
    for (const p of all(`SELECT * FROM projects WHERE onboarding_status = 'pr_open' AND onboarding_pr IS NOT NULL`)) {
      try {
        if ((await prState(p, p.onboarding_pr)).state === 'MERGED') markOnboarded(p.id)
      } catch (e) { console.error('onboarding poll', p.id, e.message) }
    }
  } finally { polling = false }
}

// Boot: no child survives a restart, so running rows are stale and mid-flight work goes back to planned.
function recover() {
  run(`UPDATE runs SET status = 'error', ended_at = ? WHERE status = 'running'`, now())
  for (const a of all(`SELECT id FROM agents WHERE status = 'working'`)) setAgent(a.id, { status: 'idle' })
  for (const t of all(`SELECT id FROM tasks WHERE status IN ('in_progress', 'in_review', 'qa')`)) failTask(t.id, 'Interrupted by a server restart.')
  for (const o of all(`SELECT id FROM orders WHERE status = 'planning'`)) setOrder(o.id, { status: 'awaiting_approval' })
  for (const o of all(`SELECT id FROM orders WHERE status = 'in_progress'`)) {
    const c = get(`SELECT COUNT(*) AS n, SUM(status != 'done') AS open FROM tasks WHERE order_id = ?`, o.id)
    if (c.n && !c.open) integrateOrder(o.id)
    // Crashed between approve and task creation: offer the plan again.
    if (!c.n) setOrder(o.id, { status: 'awaiting_approval' })
  }
}

let started = false
export function start() {
  if (started) return
  started = true
  recover()
  setInterval(tick, 5000)
  setInterval(poll, 60000)
  tick()
  poll()
}
