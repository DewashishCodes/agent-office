import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { all, get, run, update, getProject, getAgent, getTask, getOrder, activeAgents, setTask, setAgent, setOrder, log, addInbox, resolveInbox, now } from './db.js'
import { emit } from './bus.js'
import { runClaude, tokensToday, projectTokensToday, projectCostToday, runningCount, killRun, interruptRun, resumeRun, liveRuns } from './runner.js'
import { ensureClone, createWorktree, removeWorktree, mergeIntoWorktree, commitAll, changedFiles, pushBranch, createPR, prComment, setIssueStatus, prState, prStates, closePR, mergePR, restack, rebaseOnto, pushTo, fetchOrigin } from './github.js'
import { checkTask } from './pipeline.js'
import { integrateOrder } from './orchestrator.js'
import { CREW_TOOLS, mcpNames, takeQueued } from './crewmcp.js'
import { vaultDir, vaultIndex } from './vault.js'
import { matchAgent, readyTasks, isAllowed, permissionPolicy, overlaps } from './rules.js'

export { matchAgent, readyTasks, isAllowed }

export const TASK_DISALLOWED = ['Bash(git push *)', 'Bash(git push*)', 'Bash(gh *)', 'Read(./.env)', 'Read(./.env.*)', 'Read(.env*)', 'Read(**/.env*)']

// Deny rules for task and QA runs: the fixed list plus every protected path, read or edit.
export const denyRules = project => [...TASK_DISALLOWED, ...project.settings.protected_paths.flatMap(p => [`Read(${p})`, `Edit(${p})`])]

// acceptEdits asks for anything outside the policy; autonomous agents keep the old bypass behavior.
export const agentMode = agent => (agent.permissions?.autonomous ? 'bypassPermissions' : 'acceptEdits')
// extraBash widens the allow list for one run only, e.g. git rebase while resolving conflicts.
export const policyFor = (project, agent, cwd, extraBash) => (tool, input) => permissionPolicy({
  ...project.settings, read_roots: [vaultDir(project.id)],
  auto_allow_bash: extraBash ? `${project.settings.auto_allow_bash}|${extraBash}` : project.settings.auto_allow_bash,
}, agent, tool, input, cwd)
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
  if (!task.issue_number || !project.settings.github_issues) return
  try { await setIssueStatus(project, task.issue_number, status) } catch (e) { log(project.id, 'error', `Issue label failed for #${task.issue_number}: ${e.message}`, { task_id: task.id }) }
}

export async function comment(project, task, body) {
  if (!task.pr_number) return
  try { await prComment(project, task.pr_number, body) } catch (e) { log(project.id, 'error', `PR comment failed on #${task.pr_number}: ${e.message}`, { task_id: task.id }) }
}

// One failure path for gate, session, Reviewer and QA failures.
export function failTask(task_id, notes) {
  const t = getTask(task_id)
  // A late failure from a canceled task must not bring it back.
  if (t.status === 'canceled') return
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

const SYSTEM_TASK = (a, t, project) => `You are ${a.name} (${a.role}) on the ${a.floor} floor of an AI crew working on the GitHub repo ${project.repo}. ${a.specialty}

${a.instructions}

Rules, no exceptions:
- Read CLAUDE.md and .crew/PLAYBOOK.md in the repo root first (copies are in the prompt). Follow their conventions, commands and definition of done.
- You may create, edit or delete only files matching your owned paths: ${a.owned_paths.join(', ')}
- Never touch protected paths, even if they look owned: ${project.settings.protected_paths.join(', ')}
- Everything else is read-only for you. Any edit outside your owned paths fails the task automatically.
- Work only in the current directory, on the current branch ${t.branch}. Do not switch, create or rebase branches.
- When done, commit with git (git add, git commit) and a clear message. Never push, never run gh, never open a PR: the crew does that for you.
- Never read, print or copy .env files or secrets.
- To try a server, start it in the background and stop it in the same command: PORT=3456 node app.js & sleep 1; curl -s localhost:3456/x; kill %1. Never kill processes by name or with taskkill: the crew itself runs on node.
- If you changed code, run the relevant tests and build from CLAUDE.md before you finish, and fix what you broke.
- If the task needs a change outside your paths, do your part and say exactly what is missing in your final message.
- Do only this task. Other tasks of the same order are listed in the prompt; they are planned for later or for someone else, so never build them early, even in files you own. Work outside your task's files is sent back by the reviewer.
- End with a short summary: what you changed, how you tested it, anything left open. Agents whose tasks depend on yours get this summary, so name the APIs, files and decisions they need.

Crew tools (MCP server "crew"):
- crew_post: tell a crew mate something they need now: an API shape, a renamed file, a decision that affects their task. Short and concrete.
- crew_ask: only when an ambiguity would change your output. Prefer "orchestrator" (knows the plan) or the peer that owns the code; ask "owner" only when the answer changes scope.
- crew_read and crew_task_status: see messages for you and what sibling tasks built.
- Messages from crew mates or the owner can arrive while you work, marked [Message from ...]. Take them into account.`

async function taskPrompt(t, a) {
  const [claude, playbook, brief] = await Promise.all(['CLAUDE.md', '.crew/PLAYBOOK.md', '.crew/BRIEF.md'].map(f => readOpt(join(t.worktree, f))))
  const notes = all('SELECT text FROM agent_notes WHERE agent_id = ? ORDER BY id', a.id).map(n => `- ${n.text}`).join('\n')
  const deps = t.depends_on.map(getTask).filter(Boolean)
  const siblings = all(`SELECT title, files FROM tasks WHERE order_id = ? AND id != ? AND status NOT IN ('done', 'canceled')`, t.order_id, t.id)
  const messages = takeQueued(a.id)
  const vault = vaultIndex(t.project_id)
  return [
    brief && `# .crew/BRIEF.md (what the owner is building)\n\n${brief}`,
    claude && `# CLAUDE.md\n\n${claude}`,
    playbook && `# .crew/PLAYBOOK.md\n\n${playbook}`,
    notes && `# Notes from the owner for you\n\n${notes}`,
    messages && `# Messages for you\n\n${messages}`,
    vault && `# Shared context vault\n\nNotes, decisions and files the crew and the owner keep. Pull what this task needs with vault_read (by id) or vault_search; record decisions others need with vault_write.\n\n${vault}`,
    `# Your task: ${t.title}\n\n${t.description}`,
    `## Acceptance criteria\n\n${t.acceptance.map(c => `- ${c}`).join('\n') || '- (none given, use the description)'}`,
    t.files.length && `## Files you are expected to touch\n\n${t.files.join('\n')}`,
    siblings.length && `## Other tasks of this order (not yours now, do not build them)\n\n${siblings.map(s => `- ${s.title}${s.files.length ? ` (${s.files.join(', ')})` : ''}`).join('\n')}`,
    deps.length && `## Already merged into your branch\n\n${deps.map(d => `- ${d.title} (${d.branch})${d.result ? `\n\n  What its agent reported:\n\n${d.result.slice(0, 2000).replace(/^/gm, '  > ')}` : ''}`).join('\n\n')}`,
    !t.attempts && t.notes && `## Notes for this task\n\n${t.notes}`,
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
    '_Opened by Agent Office._',
  ].filter(Boolean).join('\n\n')
}

const RESTARTED = 'The crew server restarted while you were working. Check git status and git log, then continue the task and end with a short summary.'

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
  const resolving = t.conflict === 2
  if (resolving) await fetchOrigin(wt.path)
  log(project.id, 'dispatch', `${agent.name} started "${t.title}"${t.attempts ? ` (attempt ${t.attempts + 1})` : ''}`, { task_id, agent_id: agent.id, order_id: t.order_id })
  issueStatus(project, t, 'in_progress')

  const common = {
    project_id: project.id, agent_id: agent.id, task_id, kind: 'task', cwd: wt.path, systemPrompt: SYSTEM_TASK(agent, t, project),
    model: agent.model, effort: agent.effort, permissionMode: agentMode(agent), disallowedTools: denyRules(project),
    permissionPolicy: policyFor(project, agent, wt.path, resolving && '^git (rebase|merge-base|checkout --(ours|theirs))\\b'), mcp: CREW_TOOLS, allowedTools: mcpNames(CREW_TOOLS),
  }
  // Feedback on a retry goes into the same session when the last one ended cleanly: it already knows the code it wrote.
  const prev = t.attempts && t.notes ? get(`SELECT session_id, status, agent_id FROM runs WHERE task_id = ? AND kind = 'task' ORDER BY id DESC`, task_id) : null
  let r = null
  // A restart cut the last session off: the same agent picks it up, anyone else starts fresh.
  const cut = t.resume_session
  if (cut) t = setTask(task_id, { resume_session: null })
  if (cut && get('SELECT agent_id FROM runs WHERE session_id = ? ORDER BY id DESC', cut)?.agent_id === agent.id) {
    r = await runClaude({ ...common, resume: cut, prompt: RESTARTED })
    if (!r.ok && !r.stopped && !getProject(project.id).paused) r = null
  } else if (prev?.session_id && prev.status === 'ok' && prev.agent_id === agent.id) {
    r = await runClaude({ ...common, resume: prev.session_id, prompt: `Your work came back (attempt ${t.attempts + 1} now). Fix these points on the same branch, run the tests again, commit, and end with a short summary.\n\n${t.notes}` })
    if (!r.ok && !r.stopped && !getProject(project.id).paused) r = null
  }
  r ??= await runClaude({ ...common, prompt: await taskPrompt(t, agent) })
  // Kill switch, removal or the owner stopping the run already put the task where it belongs; not an attempt.
  if (r.stopped || getProject(project.id).paused) return
  if (!r.ok) return failTask(task_id, `The session crashed: ${String(r.text).slice(0, 2000)}`)
  setTask(task_id, { result: r.text })

  await commitAll(wt.path, `${t.title} (crew task ${t.id})`)
  // After a rebase the old base is gone from the branch; the gate and review compare against where it now sits.
  if (resolving) t = setTask(task_id, { base_sha: await git(wt.path, 'merge-base', 'HEAD', `origin/${project.default_branch}`) })
  const files = await changedFiles(wt.path, t.base_sha)
  if (!files.length) return failTask(task_id, 'No files changed. Make the change and commit it.')
  const bad = files.filter(f => !isAllowed(f, agent.owned_paths, project.settings.protected_paths))
  if (bad.length) {
    log(project.id, 'gate', `Gate rejected "${t.title}": ${bad.join(', ')}`, { task_id, agent_id: agent.id })
    return failTask(task_id, `These files are outside your owned paths or inside protected paths. Revert every change to them (git checkout ${t.base_sha} -- <file>, or git rm for new files) and commit:\n${bad.map(f => `- ${f}`).join('\n')}`)
  }

  // Canceled while the run was wrapping up: no PR, no review.
  if (getTask(task_id).status === 'canceled') return
  if (getOrder(t.order_id)?.hotfix) {
    // Never forced: a protected branch or one that moved mid-push fails the task to the Inbox instead.
    t = setTask(task_id, { base_sha: await rebaseOnto(wt.path, t.base_sha, branch, project.default_branch) })
    await pushTo(wt.path, `${branch}:refs/heads/${project.default_branch}`)
    t = setTask(task_id, { status: 'done' })
    issueStatus(project, t, 'done')
    log(project.id, 'hotfix', `${agent.name} pushed hotfix "${t.title}" straight to ${project.default_branch}`, { task_id, agent_id: agent.id, order_id: t.order_id })
    return markMerged(task_id)
  }
  await pushBranch(wt.path, branch, { force: resolving })
  if (resolving) t = setTask(task_id, { conflict: 0 })
  if (!t.pr_number) {
    const pr = await createPR(project, { branch, title: t.title, body: prBody(t) })
    t = setTask(task_id, { pr_number: pr.number, pr_url: pr.url })
  } else await comment(project, t, `Attempt ${t.attempts + 1} pushed, addressing:\n\n${t.notes}`)
  if (getTask(task_id).status === 'canceled') return
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
  const dollars = p.settings.project_daily_cost_budget
  if (dollars != null && projectCostToday(p.id) >= dollars) {
    if (oncePerDay(`cost:p${p.id}`)) {
      log(p.id, 'budget', `Project daily cost budget ($${dollars}) reached; no new tasks start until tomorrow.`)
      addInbox(p.id, 'question', 'Project daily cost budget reached', { body: 'Raise the daily cost budget in Settings or wait until tomorrow.' })
    }
    return
  }
  // Every task of the project, so a dependency on another order counts once it is done.
  const tasks = all(`SELECT t.*, o.status order_status, o.floor order_floor FROM tasks t JOIN orders o ON o.id = t.order_id WHERE t.project_id = ? ORDER BY t.id`, p.id)
  const active = tasks.filter(t => ['in_progress', 'in_review', 'qa'].includes(t.status))
  const agents = activeAgents(p.id)
  for (const t of readyTasks(tasks).filter(t => t.order_status === 'in_progress')) {
    // Two orders editing the same files would conflict at merge time; the later one waits.
    const lock = active.find(x => x.order_id !== t.order_id && overlaps(t.files, x.files))
    const reason = lock ? `Waiting for #${lock.id} (same files)` : null
    if (reason !== t.wait_reason) setTask(t.id, { wait_reason: reason })
    if (lock) continue
    let a = agents.find(x => x.id === t.agent_id)
    if (!a || a.status === 'paused') {
      const pick = matchAgent(agents.filter(x => x.floor === t.order_floor), t)
      // A paused owner with no stand-in waits; it is not a failure.
      if (!pick && a) continue
      if (!pick) {
        const files = t.files.join(', ') || '(no files listed)'
        setTask(t.id, { status: 'blocked', agent_id: null, notes: `No agent covers ${files}` })
        addInbox(p.id, 'question', `No agent covers ${files}`, { body: `Task "${t.title}" (${t.plan_agent || `role ${t.role}`}) needs an agent whose owned paths cover ${files}. Add or edit an agent, then retry the task.`, order_id: t.order_id, task_id: t.id })
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
    active.push(t)
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

const IN_FLIGHT = `('in_progress', 'in_review', 'qa')`

// Removal never breaks work in flight: its runs stop without counting an attempt and the next tick re-matches by paths.
export function removeAgent(agent_id) {
  const a = getAgent(agent_id)
  setAgent(a.id, { removed_at: now(), status: 'idle' })
  const tasks = all(`SELECT id, status, notes FROM tasks WHERE agent_id = ? AND status IN ('planned', 'in_progress', 'in_review', 'qa')`, a.id)
  for (const r of all(`SELECT id FROM runs WHERE status = 'running' AND (agent_id = ? OR task_id IN (SELECT id FROM tasks WHERE agent_id = ? AND status IN ${IN_FLIGHT}))`, a.id, a.id)) killRun(r.id)
  for (const t of tasks) {
    const notes = t.status === 'planned' ? t.notes : [`Reassigned: ${a.name} was removed.`, t.notes].filter(Boolean).join('\n\n')
    setTask(t.id, { agent_id: null, status: 'planned', notes })
  }
  // Blocked stays blocked; a retry re-matches.
  for (const t of all(`SELECT id FROM tasks WHERE agent_id = ? AND status = 'blocked'`, a.id)) setTask(t.id, { agent_id: null })
  log(a.project_id, 'agent', `Removed ${a.name}${tasks.length ? `, ${tasks.length} task(s) go back to the queue` : ''}`, { agent_id: a.id })
  kick()
  return getAgent(a.id)
}

const agentRuns = agent_id => liveRuns().filter(r => r.agent_id === agent_id)

export async function pauseAgent(agent_id) {
  const a = setAgent(agent_id, { status: 'paused' })
  for (const r of agentRuns(agent_id)) if (r.state === 'running' || r.state === 'waiting') await interruptRun(r.run_id)
  return a
}

export function resumeAgent(agent_id) {
  const paused = agentRuns(agent_id).filter(r => r.state === 'paused')
  for (const r of paused) resumeRun(r.run_id)
  const a = setAgent(agent_id, { status: runningCount(agent_id) ? 'working' : 'idle' })
  kick()
  return a
}

const pause = ms => new Promise(r => setTimeout(r, ms))

// The owner's merge: a task built on others is restacked onto the default branch first (their squash merges rewrote the
// commits it carries), then squash merged. GitHub needs a moment to recompute mergeability after a force push.
export async function mergeTask(task_id) {
  let t = getTask(task_id)
  if (t.merged) return t
  if (!t.pr_number) throw new Error(`"${t.title}" has no pull request`)
  const project = getProject(t.project_id)
  if (t.depends_on.length) {
    const open = t.depends_on.map(getTask).filter(d => d && !d.merged && d.status !== 'canceled')
    if (open.length) throw new Error(`Merge ${open.map(d => `#${d.pr_number || d.id} "${d.title}"`).join(', ')} first: this PR builds on it.`)
    if (t.worktree && t.base_sha) {
      try { t = setTask(t.id, { base_sha: await restack(t.worktree, t.base_sha, t.branch, project.default_branch) }) } catch (e) {
        setTask(t.id, { conflict: 1 })
        throw e
      }
    }
  }
  for (let i = 0; ; i++) {
    try { await mergePR(project, t.pr_number); break } catch (e) {
      if (i >= 3 || !t.depends_on.length) throw e
      await pause(4000)
    }
  }
  markMerged(t.id)
  return getTask(t.id)
}

// "Resolve conflicts": the author takes the task back on the same branch to rebase it onto the project branch. Not an
// attempt. Its order goes back to in progress so integration (and the merge cards) run again once it passes review.
export function resolveConflicts(task_id) {
  const t = getTask(task_id)
  if (t.merged || t.status !== 'done' || !t.pr_number) throw new Error('Only a finished task with an open PR can be sent back to resolve conflicts')
  const project = getProject(t.project_id)
  for (const i of all(`SELECT id FROM inbox WHERE order_id = ? AND kind = 'merge' AND status = 'open'`, t.order_id)) resolveInbox(i.id)
  if (getOrder(t.order_id).status === 'ready_to_merge') setOrder(t.order_id, { status: 'in_progress' })
  const notes = `Your PR conflicts with ${project.default_branch}. Run git rebase origin/${project.default_branch} (the server already fetched), resolve every conflict, git add the files, continue with GIT_EDITOR=true git rebase --continue, run the tests, and make sure everything is committed. Do not push; the server pushes.`
  log(t.project_id, 'task', `Sent "${t.title}" back to resolve conflicts with ${project.default_branch}`, { task_id: t.id, order_id: t.order_id })
  const out = setTask(t.id, { status: 'planned', conflict: 2, notes })
  kick()
  return out
}

// A finished or dropped task's worktree is dead weight under data/worktrees. Canceled runs get a moment to exit first:
// Windows keeps files of a dying process locked.
function dropWorktree(t, delay = 0) {
  if (!t.worktree) return
  setTimeout(() => removeWorktree(getProject(t.project_id), t.worktree).catch(e => console.error('worktree remove', t.id, e.message)), delay).unref?.()
}

// Shared by the PR poll and the Inbox merge action; idempotent so a merge seen by both is handled once.
export function markMerged(task_id) {
  const t = getTask(task_id)
  if (t.merged) return
  setTask(t.id, { merged: 1, merged_at: now() })
  dropWorktree(t)
  if (t.pr_number) log(t.project_id, 'merge', `PR #${t.pr_number} merged: ${t.title}`, { task_id: t.id, order_id: t.order_id, link: t.pr_url })
  for (const i of all(`SELECT id FROM inbox WHERE task_id = ? AND kind = 'merge' AND status = 'open'`, t.id)) resolveInbox(i.id)
  const left = get(`SELECT COUNT(*) AS n FROM tasks WHERE order_id = ? AND merged = 0 AND status != 'canceled'`, t.order_id).n
  if (!left && !['done', 'canceled'].includes(getOrder(t.order_id).status)) {
    setOrder(t.order_id, { status: 'done' })
    log(t.project_id, 'order', 'Order done: every PR merged', { order_id: t.order_id })
  }
}

// The owner drops an order: its unfinished tasks stop for good and leave the board. Done tasks keep their PRs.
export function cancelOrder(order_id) {
  const o = getOrder(order_id)
  const tasks = all(`SELECT id, project_id, worktree, pr_number FROM tasks WHERE order_id = ? AND status != 'done'`, order_id)
  const ids = new Set(tasks.map(t => t.id))
  // stopped: the runner's caller must not count it as a failed attempt or retry it.
  for (const r of liveRuns()) if (ids.has(r.task_id)) killRun(r.run_id)
  for (const t of tasks) setTask(t.id, { status: 'canceled', wait_reason: null })
  // A task with an open PR keeps its branch and worktree; the owner may still merge or close it.
  for (const t of tasks) if (!t.pr_number) dropWorktree(t, 10000)
  for (const i of all(`SELECT id FROM inbox WHERE status = 'open' AND (order_id = ? OR task_id IN (SELECT id FROM tasks WHERE order_id = ?))`, order_id, order_id)) resolveInbox(i.id)
  setOrder(order_id, { status: 'canceled' })
  log(o.project_id, 'order', `Order canceled: ${o.plan?.summary || o.text}`, { order_id })
  kick()
}

// The owner drops one task: its run stops, its open PR closes, tasks waiting on it block, the rest of the order carries on.
export function cancelTask(task_id) {
  const t = getTask(task_id)
  if (['done', 'canceled'].includes(t.status) || t.merged) throw new Error(`That task is already ${t.merged ? 'merged' : t.status}`)
  for (const r of liveRuns()) if (r.task_id === t.id) killRun(r.run_id)
  setTask(t.id, { status: 'canceled', wait_reason: null })
  for (const i of all(`SELECT id FROM inbox WHERE status = 'open' AND task_id = ?`, t.id)) resolveInbox(i.id)
  if (t.pr_number) closePR(getProject(t.project_id), t.pr_number).catch(e => log(t.project_id, 'error', `Closing PR #${t.pr_number} failed: ${e.message}`, { task_id: t.id }))
  dropWorktree(t, 10000)
  for (const d of all(`SELECT id, depends_on FROM tasks WHERE project_id = ? AND status = 'planned'`, t.project_id)) {
    if (d.depends_on.includes(t.id)) setTask(d.id, { status: 'blocked', notes: `Depends on "${t.title}", which the owner canceled. Retry to go ahead without it.` })
  }
  log(t.project_id, 'task', `Task canceled by the owner: ${t.title}`, { task_id: t.id, order_id: t.order_id })
  const o = getOrder(t.order_id)
  const c = get(`SELECT SUM(status NOT IN ('done', 'canceled')) AS open, SUM(status = 'done') AS done, SUM(status = 'done' AND merged = 0) AS unmerged FROM tasks WHERE order_id = ?`, o.id)
  if (!c.open) {
    if (!c.done) setOrder(o.id, { status: 'canceled' })
    else if (o.status === 'in_progress') integrateOrder(o.id).catch(e => log(o.project_id, 'error', `Integration failed: ${e.message}`, { order_id: o.id }))
    else if (o.status === 'ready_to_merge' && !c.unmerged) setOrder(o.id, { status: 'done' })
  }
  kick()
  return getTask(t.id)
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
// One gh call per project however many PRs are open; list and one are swappable for tests.
export async function poll({ list = prStates, one = prState } = {}) {
  if (polling) return
  polling = true
  try {
    const open = all('SELECT * FROM tasks WHERE pr_number IS NOT NULL AND merged = 0')
    for (const project_id of new Set(open.map(t => t.project_id))) {
      const p = getProject(project_id)
      let prs
      try { prs = await list(p) } catch (e) { console.error('pr poll', p.id, e.message); continue }
      for (const t of open.filter(t => t.project_id === project_id)) {
        try {
          const pr = prs.get(t.pr_number) || await one(p, t.pr_number)
          if (pr.checks !== t.checks) setTask(t.id, { checks: pr.checks })
          if (pr.state === 'MERGED') markMerged(t.id)
        } catch (e) { console.error('pr poll', t.id, e.message) }
      }
    }
    for (const p of all(`SELECT * FROM projects WHERE onboarding_status = 'pr_open' AND onboarding_pr IS NOT NULL`)) {
      try {
        if ((await prState(p, p.onboarding_pr)).state === 'MERGED') markOnboarded(p.id)
      } catch (e) { console.error('onboarding poll', p.id, e.message) }
    }
  } finally { polling = false }
}

// Review and QA that were cut off (restart, kill switch) run again from the review step.
export function resumeChecks(project_id = null) {
  const rows = all(`SELECT id, worktree, base_sha FROM tasks WHERE status IN ('in_review', 'qa') AND (? IS NULL OR project_id = ?)`, project_id, project_id)
  for (const t of rows) {
    if (get(`SELECT 1 FROM runs WHERE task_id = ? AND status = 'running'`, t.id)) continue
    if (!t.worktree || !t.base_sha) { setTask(t.id, { status: 'planned' }); continue }
    setTask(t.id, { status: 'in_review' })
    checkTask(t.id).catch(e => failTask(t.id, `Error: ${e.message}`))
  }
}

// Boot: no child survives a restart, so running rows are stale. A restart is never the task's fault, so no attempt is counted.
export function recover() {
  // The agent's context survives in its session; picking it up again is cheaper than starting from the prompt.
  for (const t of all(`SELECT id, agent_id FROM tasks WHERE status = 'in_progress'`)) {
    const r = get(`SELECT session_id FROM runs WHERE task_id = ? AND kind = 'task' AND agent_id = ? AND session_id IS NOT NULL ORDER BY id DESC`, t.id, t.agent_id)
    if (r) update('tasks', t.id, { resume_session: r.session_id })
  }
  run(`UPDATE runs SET status = 'error', pending_permission = NULL, ended_at = ? WHERE status = 'running'`, now())
  run(`UPDATE inbox SET status = 'done', resolved_at = ? WHERE kind = 'permission' AND status = 'open'`, now())
  for (const a of all(`SELECT id FROM agents WHERE status = 'working'`)) setAgent(a.id, { status: 'idle' })
  for (const t of all(`SELECT id FROM tasks WHERE status = 'in_progress'`)) setTask(t.id, { status: 'planned' })
  resumeChecks()
  for (const o of all(`SELECT id FROM orders WHERE status = 'planning'`)) setOrder(o.id, { status: 'awaiting_approval' })
  for (const o of all(`SELECT id FROM orders WHERE status = 'in_progress'`)) {
    const c = get(`SELECT COUNT(*) AS n, SUM(status NOT IN ('done', 'canceled')) AS open FROM tasks WHERE order_id = ?`, o.id)
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
