import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { get, getProject, getTask, getOrder, getAgent, activeAgents, setTask, log } from './db.js'
import { runClaude } from './runner.js'
import { failTask, issueStatus, comment, git, denyRules, agentMode, policyFor } from './scheduler.js'
import { integrateOrder } from './orchestrator.js'
import { CREW_TOOLS, VAULT_READ, mcpNames } from './crewmcp.js'
import { parseVerdict } from './rules.js'

const MAX_DIFF = 200_000

const readOpt = p => readFile(p, 'utf8').catch(() => '')

const SYSTEM_REVIEW = (a, project) => `You are ${a.name}, the reviewer on the ${a.floor} floor of an AI crew working on the GitHub repo ${project.repo}. ${a.specialty}

${a.instructions}

Rules:
- Read CLAUDE.md and .crew/PLAYBOOK.md in the repo root first. Their conventions are the standard you review against.
- You only read (Read, Grep, Glob). Never edit files.
- Call crew_read first: the author or the Orchestrator may have explained decisions about this task there.
- The diff is in the prompt. Open the changed files for context when the diff is not enough.
- Ask for changes only for real bugs, a missing or unmet acceptance criterion, a broken convention from CLAUDE.md, a security problem, or changes outside the task scope. Style nits are not a reason to block; mention them as optional.
- Notes go straight to the developer for the next attempt, so make each one specific: file, what is wrong, what to do.
- End your reply with exactly one fenced json block, nothing after it:
\`\`\`json
{"verdict": "approve", "notes": "Short summary of what you checked and any optional nits."}
\`\`\`
or
\`\`\`json
{"verdict": "changes", "notes": "1. server/auth.js: token is never checked for expiry, add the check and a test. 2. ..."}
\`\`\``

const SYSTEM_QA = (a, project) => `You are ${a.name}, QA on an AI dev crew working on the GitHub repo ${project.repo}. ${a.specialty}

${a.instructions}

Rules:
- Read CLAUDE.md and .crew/PLAYBOOK.md in the repo root first. Use the install, test and build commands they give.
- Test the branch checked out in the current directory. Do not edit, commit or push anything, never run gh, never read .env files.
- Run the tests and build. Then check every acceptance criterion one by one with evidence (command output, file and line).
- Fail only for failing tests or build, or an acceptance criterion that is not met. Tests that already failed before this change are not this task's fault: say so and do not fail for them.
- If a command needs something unavailable (secrets, network, a service), say so and judge from what you can run.
- To try a server, start it in the background and stop it in the same command: PORT=3456 node app.js & sleep 1; curl -s localhost:3456/x; kill %1. Never kill processes by name or with taskkill: the crew itself runs on node.
- End your reply with exactly one fenced json block, nothing after it:
\`\`\`json
{"verdict": "pass", "report": "npm test: 42 passed. Criterion 1 met (server/auth.test.js). Criterion 2 met ..."}
\`\`\`
or
\`\`\`json
{"verdict": "fail", "report": "npm test: 2 failed (auth.test.js 'rejects expired token': expected 401 got 200). Criterion 2 not met: ..."}
\`\`\``

const SYSTEM_CHECK = (a, project) => `${SYSTEM_QA(a, project)}

This is a small task, so you also do the code review, before running the checks:
- Call crew_read first: the author or the Orchestrator may have explained decisions there.
- The diff is in the prompt. Fail it for real bugs, a missing or unmet acceptance criterion, a broken convention from CLAUDE.md, a security problem, or changes outside the task scope. Style nits are not a reason to fail; mention them as optional.
- Put review findings and test evidence together in "report", each point specific: file, what is wrong, what to do.`

const taskBlock = t => `# Task: ${t.title}

${t.description}

## Acceptance criteria
${t.acceptance.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none given, judge from the description)'}`

const docs = async t => {
  const [claude, playbook] = await Promise.all([readOpt(join(t.worktree, 'CLAUDE.md')), readOpt(join(t.worktree, '.crew', 'PLAYBOOK.md'))])
  return [claude && `# CLAUDE.md\n\n${claude}`, playbook && `# .crew/PLAYBOOK.md\n\n${playbook}`].filter(Boolean).join('\n\n')
}

// The task's own floor checks it. A floor without a reviewer borrows any; QA (tests and builds) exists only where code is.
const pick = (project_id, role, floor) => {
  const ok = activeAgents(project_id).filter(a => a.role === role && a.status !== 'paused')
  return ok.find(a => a.floor === floor) || (role === 'reviewer' ? ok[0] : null)
}

// Runs one check. Returns 'pass' | 'fail' | 'skip' | 'stop'; on fail the task is already sent back.
async function step(t, project, opts) {
  const { role, kind, system, prompt, tools, mode, disallowed, okWord, badWord, field, label, policy, mcp } = opts
  const a = pick(project.id, role, t.floor)
  if (!a) {
    log(project.id, kind, `No active ${role} agent; skipped ${label} for "${t.title}"`, { task_id: t.id, order_id: t.order_id })
    return 'skip'
  }
  const r = await runClaude({
    project_id: project.id, agent_id: a.id, task_id: t.id, kind, cwd: t.worktree,
    prompt, systemPrompt: system(a, project), model: a.model, effort: a.effort,
    allowedTools: [...tools, ...mcpNames(mcp)], mcp, disallowedTools: disallowed, permissionMode: mode ?? agentMode(a),
    permissionPolicy: policy && policyFor(project, a, t.worktree),
  })
  // The checker was removed mid-run: another one of that role takes over.
  if (r.stopped && getAgent(a.id).removed_at && !getProject(project.id).paused) return step(t, project, opts)
  if (r.stopped || getProject(project.id).paused) return 'stop'
  if (!r.ok) { failTask(t.id, `${label} session crashed: ${String(r.text).slice(0, 1000)}`); return 'stop' }
  let v = parseVerdict(r.text)
  if (![okWord, badWord].includes(v?.verdict)) {
    log(project.id, 'warning', `${label} verdict unreadable for "${t.title}", counting it as ${okWord}`, { task_id: t.id, agent_id: a.id })
    v = { verdict: okWord, [field]: r.text.slice(-4000) }
  }
  const text = String(v[field] ?? '')
  await comment(project, t, `**${label} (${a.name}): ${v.verdict}**\n\n${text}`)
  log(project.id, kind, `${a.name}: ${v.verdict} on "${t.title}"`, { task_id: t.id, agent_id: a.id, order_id: t.order_id, link: t.pr_url })
  if (v.verdict === badWord) { failTask(t.id, `${label} feedback:\n${text}`); return 'fail' }
  return 'pass'
}

export async function checkTask(task_id) {
  let t = getTask(task_id)
  const project = getProject(t.project_id)
  t.floor = getOrder(t.order_id)?.floor || 'tech'
  const context = `${await docs(t)}\n\n${taskBlock(t)}`

  let diff = await git(t.worktree, 'diff', `${t.base_sha}..HEAD`)
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n... diff truncated, read the files for the rest`
  const diffBlock = `## Diff (git diff ${t.base_sha}..HEAD)\n\n\`\`\`diff\n${diff}\n\`\`\``
  const qa = {
    role: 'qa', kind: 'qa', label: 'QA', system: SYSTEM_QA,
    prompt: `${context}\n\nThe branch ${t.branch} is checked out here. Run the checks and end with the json verdict block.`,
    // Bash is left out of the allow list so each command goes through the permission policy; QA never edits.
    tools: ['Read', 'Grep', 'Glob'], mcp: CREW_TOOLS, mode: null, policy: true, disallowed: [...denyRules(project), 'Edit', 'Write', 'NotebookEdit'],
    okWord: 'pass', badWord: 'fail', field: 'report',
  }
  const floor = t.floor
  const toQa = () => { t = { ...setTask(task_id, { status: 'qa' }), floor }; issueStatus(project, t, 'qa') }

  // S tasks get one session that reviews and tests: a second session would mostly repeat its own startup cost.
  if (t.size === 'S' && pick(project.id, 'qa', floor)) {
    toQa()
    const both = await step(t, project, {
      ...qa, label: 'Review and QA', system: SYSTEM_CHECK,
      prompt: `${context}\n\n${diffBlock}\n\nThe branch ${t.branch} is checked out here. Review the diff, run the checks, and end with the json verdict block.`,
    })
    if (both === 'fail' || both === 'stop') return
  } else {
    const review = await step(t, project, {
      role: 'reviewer', kind: 'review', label: 'Review', system: SYSTEM_REVIEW,
      prompt: `${context}\n\n${diffBlock}\n\nReview it and end with the json verdict block.`,
      tools: ['Read', 'Grep', 'Glob'], mcp: ['crew_read', ...VAULT_READ], mode: 'dontAsk', disallowed: [], okWord: 'approve', badWord: 'changes', field: 'notes',
    })
    if (review === 'fail' || review === 'stop') return
    if (pick(project.id, 'qa', floor)) {
      toQa()
      const tested = await step(t, project, qa)
      if (tested === 'fail' || tested === 'stop') return
    }
  }

  t = setTask(task_id, { status: 'done' })
  issueStatus(project, t, 'done')
  log(project.id, 'done', `"${t.title}" passed ${floor === 'tech' ? 'review and QA' : 'review'}`, { task_id, agent_id: t.agent_id, order_id: t.order_id, link: t.pr_url })
  // Checked synchronously right after our own update, so only the last task to finish triggers it.
  if (!get(`SELECT COUNT(*) AS n FROM tasks WHERE order_id = ? AND status != 'done'`, t.order_id).n) await integrateOrder(t.order_id)
}
