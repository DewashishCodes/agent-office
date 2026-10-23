import { all, get, insert, getProject, getOrder, activeAgents, setTask, setOrder, log, addMessage, addInbox, resolveInbox } from './db.js'
import { emit } from './bus.js'
import { runClaude } from './runner.js'
import { ensureClone, pullDefault, createIssue, prDiff, prMergeable } from './github.js'
import { kick } from './scheduler.js'
import { FLOORS, floorOf } from './roster.js'
import { parseReply, parseVerdict, matchAgent, findCycle, chainOrder } from './rules.js'

// Named here, not imported from crewmcp.js, which imports this module.
const ORCH_TOOLS = ['crew_post', 'crew_read', 'vault_search', 'vault_read', 'vault_write']

export { parseReply }

const MAX_DIFFS = 150_000

// Cheap guess for the instant ack; a wrong guess only costs one extra chat line.
const ORDER_WORDS = /\b(add|build|make|create|implement|fix|change|update|remove|delete|refactor|rewrite|write|migrate|rename|replace|support|improve|redesign|move|split|upgrade)\b/i

const EXAMPLE_PLAN = `{
  "summary": "Add Google sign-in",
  "tasks": [
    {
      "key": "t1",
      "title": "Google OAuth callback endpoint",
      "agent": "Backend Dev",
      "description": "Add GET /api/auth/google/callback that exchanges the code, upserts the user and sets the session cookie. Follow the existing session helper in server/session.js.",
      "acceptance": ["Valid code creates or updates the user and sets the session cookie", "Invalid code returns 401 with a JSON error", "Integration test covers both cases"],
      "size": "M",
      "depends_on": [],
      "files": ["server/auth/**", "server/routes.js", "server/auth.test.js"]
    },
    {
      "key": "t2",
      "title": "Sign in with Google button",
      "agent": "Frontend Dev",
      "description": "Add the button to the login screen. It links to /api/auth/google and shows the error from the callback query string.",
      "acceptance": ["Button visible on the login screen", "Error message shown when ?error= is present"],
      "size": "S",
      "depends_on": ["t1"],
      "files": ["web/src/screens/Login.jsx", "web/src/styles.css"]
    }
  ]
}`

// Support is not part of the build team; it never gets planned tasks.
const roster = agents => agents.filter(a => !['support', 'onboarding'].includes(a.role)).map(a => `- ${a.name} (${a.role}${a.status === 'paused' ? ', paused' : ''}): ${a.specialty || 'no specialty'}. Owns: ${a.owned_paths.length ? a.owned_paths.join(', ') : 'nothing, never gets tasks'}`).join('\n')

// Non-tech floors plan documents in their folder; code belongs to the Tech floor.
const floorScope = (f, leads) => `${f.key === 'tech' ? '' : `
Your floor writes documents, not code: every task's "files" must sit under ${f.folder}/. When an order needs code or another floor's documents, plan only your part and tell the owner which floor should do the rest. The example plan below shows the format only, not your kind of work.
`}${leads.length ? `
Other floors and their leads. To give another floor work (code, a page, their documents), crew_post the full order to its lead by name: it becomes an order on their floor, planned by them and approved by the owner. Do not ask the owner to paste it. The leads:
${leads.map(a => `- ${floorOf(a.floor)?.name || a.floor}: ${a.name}`).join('\n')}
` : ''}`

const SYSTEM_ORCH = (lead, project, agents, floor, leads) => `You are ${lead?.name || 'the Orchestrator'}, the lead of the ${floor.name} floor of an AI crew working on the GitHub repo ${project.repo} (default branch ${project.default_branch}). ${floor.blurb} Your working directory is a fresh clone of it. You can read code (Read, Grep, Glob) but you never edit files and never run commands.

${lead?.instructions || ''}
${floorScope(floor, leads)}
Before answering about the code or planning, read .crew/BRIEF.md, CLAUDE.md and .crew/PLAYBOOK.md in the repo root if they exist: they describe what the owner is building, the stack, commands and team rules. Look at the real code before you plan; do not guess file paths.

Your crew (only agents that own paths can take tasks):
${roster(agents)}

Protected paths no agent may touch: ${project.settings.protected_paths.join(', ')}
${inFlight(project.id)}

How to answer the owner:
1. A question or chat: answer in plain text, short. No json block.
2. An order that is ambiguous (unclear goal, scope or behavior that would change the plan): ask at most 3 short numbered questions in plain text. No json block.
3. A clear order: reply with a 1 to 3 sentence summary in plain words, then the plan as one fenced json block, as the last thing in the reply. Do not state how many tasks or PRs there are; the owner sees the plan itself.

Plan rules:
- One task = one pull request by one agent. Size S (under an hour), M (a few hours), L (a day). Prefer S and M; split anything bigger.
- Plan for parallel work: agents work at the same time only on tasks with no dependency between them. Prefer independent tasks over a chain (agree on the interface in the descriptions instead of waiting for code), and spread tasks across the agents who own the files rather than giving most of them to one.
- "agent" is the exact name of an agent above that owns paths. Several agents can share a role, so always assign by name. Older plans in this chat used a "role" field; that format is retired, always write "agent". Never give tasks to the orchestrator, reviewer or qa agents; every task is reviewed and tested automatically, so do not plan review or test-only tasks.
- "files" lists the paths or globs the task will touch. Every entry must fall inside the owned paths of that agent, or nobody can take the task and it is blocked. If work spans two agents, split it into two tasks.
- Never plan changes to protected paths. If the order needs one, say so in the summary and leave it to the owner.
- "depends_on" lists keys of tasks that must be done first; their branches are merged into the dependent branch. No cycles. Independent tasks run in parallel, so only add real dependencies. To wait for a task of an order already in flight, use "order:<id>/<key>", for example "order:3/t2".
- "acceptance" holds concrete, checkable criteria. Reviewer and QA judge exactly these, so include the tests you expect.
- "description" says what to build and where, naming the existing code to follow.
- "key" is a short unique id: t1, t2, ...

Plan format, exactly this shape:
\`\`\`json
${EXAMPLE_PLAN}
\`\`\``

// Other orders still being built, so a new plan neither repeats them nor edits the same files at the same time.
function inFlight(project_id) {
  const orders = all(`SELECT * FROM orders WHERE project_id = ? AND status IN ('in_progress', 'ready_to_merge') ORDER BY id`, project_id)
  if (!orders.length) return ''
  const lines = orders.map(o => [`- Order #${o.id} "${o.plan?.summary || o.text}" (${o.status}):`,
    ...all('SELECT plan_key, title, status, files FROM tasks WHERE order_id = ? ORDER BY id', o.id)
      .map(t => `  - ${t.plan_key} "${t.title}" [${t.status}] files: ${t.files.join(', ') || '(none listed)'}`)].join('\n'))
  return `
Orders already in flight. Do not plan their work again. A new task that touches the same files waits until theirs are done (the scheduler enforces it), so either avoid those files or add a depends_on like "order:<id>/<key>":
${lines.join('\n')}`
}

const lead = (agents, floor) => agents.find(a => a.role === 'orchestrator' && a.floor === floor)
// A message lands in the chat its order was made in, else the floor's latest chat.
const say = (project_id, floor, role, text, order_id = null, chat_id = chatFor(project_id, floor, order_id)) =>
  addMessage(project_id, role, text, order_id, { floor, chat_id })

export function newChat(project_id, floor, text) {
  const id = insert('chats', { project_id, floor, title: String(text).replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat' })
  emit('chat', project_id, get('SELECT * FROM chats WHERE id = ?', id))
  return id
}

export const chatFor = (project_id, floor, order_id) => (order_id && getOrder(order_id)?.chat_id) ||
  get('SELECT id FROM chats WHERE project_id = ? AND floor = ? ORDER BY updated_at DESC, id DESC LIMIT 1', project_id, floor)?.id ||
  newChat(project_id, floor, 'Crew')

// Every request is a fresh session: resuming one ever-growing chat re-read its whole history on each call and cost
// more than the work it planned. The recent messages of this chat and finished orders come in the prompt instead.
function withChat(project_id, floor, chat_id, before_id, text) {
  const msgs = all('SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT 12) ORDER BY id', chat_id, before_id)
  const done = all(`SELECT id, text, plan, status FROM orders WHERE project_id = ? AND floor = ? AND status IN ('done', 'ready_to_merge') ORDER BY id DESC LIMIT 5`, project_id, floor)
  const who = { user: 'Owner', orchestrator: 'You', system: 'Crew' }
  return [
    done.length && `# Recently finished orders\n\n${done.map(o => `- #${o.id} ${o.plan?.summary || o.text} (${o.status})`).join('\n')}`,
    msgs.length && `# Earlier in this chat\n\n${msgs.map(m => `${who[m.role] || m.role}: ${m.text.slice(0, 800)}${m.order_id ? ` [plan for order #${m.order_id}]` : ''}`).join('\n\n')}`,
    `# The owner now says\n\n${text}`,
  ].filter(Boolean).join('\n\n')
}

// One lead run per floor at a time, in order; prompts may be functions so a queued request sees the replies before it.
const asking = new Map()
const waiting = new Map()
function ask(project_id, floor, ...rest) {
  const q = `${project_id}:${floor}`
  waiting.set(q, (waiting.get(q) || 0) + 1)
  const p = (asking.get(q) || Promise.resolve()).then(() => askNow(project_id, floor, ...rest))
    .finally(() => waiting.set(q, waiting.get(q) - 1))
  asking.set(q, p.catch(() => {}))
  return p
}

// An agent asks mid-task through crew_ask; the answer goes back to it and shows in the chat as a crew line.
export async function askFromAgent(project_id, agent, task, question, floor = agent?.floor || 'tech') {
  const about = task ? ` while working on task #${task.id} "${task.title}"` : ''
  const plan = task && getOrder(task.order_id)?.plan
  const r = await ask(project_id, floor, `[Not the owner: ${agent?.name || 'an agent'} (${agent?.role || 'agent'}) asks${about}. Answer the agent directly, briefly, in plain text. No plan and no json block.]${plan ? `\n\nThe plan this task belongs to:\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`` : ''}\n\n${question}`)
  const answer = r.ok ? parseReply(r.text).text || '(no answer)' : `The Orchestrator could not answer: ${String(r.text).slice(0, 500)}`
  say(project_id, floor, 'system', `${agent?.name || 'An agent'} asked the lead${about}: ${question}\n\nAnswer: ${answer}`, null, chatFor(project_id, floor, task?.order_id))
  return answer
}

// Runs the Orchestrator in a fresh session on the clone.
async function askNow(project_id, floor, prompt, { kind = 'orchestrator' } = {}) {
  let project = getProject(project_id)
  if (!project.local_path) await ensureClone(project)
  await pullDefault(getProject(project_id))
  project = getProject(project_id)
  const crew = activeAgents(project_id), agents = crew.filter(a => a.floor === floor), orch = lead(agents, floor)
  const leads = crew.filter(a => a.role === 'orchestrator' && a.floor !== floor)
  const base = {
    project_id, agent_id: orch?.id ?? null, kind, cwd: project.local_path, prompt: typeof prompt === 'function' ? prompt() : prompt,
    systemPrompt: SYSTEM_ORCH(orch, project, agents, floorOf(floor) || FLOORS[0], leads), model: orch?.model || 'opus', effort: orch?.effort || 'high',
    allowedTools: ['Read', 'Grep', 'Glob', ...ORCH_TOOLS.map(t => `mcp__crew__${t}`)], permissionMode: 'dontAsk',
    mcp: ORCH_TOOLS,
  }
  return runClaude(base)
}

const openPlanItems = order_id => all(`SELECT id FROM inbox WHERE order_id = ? AND kind = 'plan' AND status = 'open'`, order_id)

function offerPlan(project_id, order_id, plan) {
  for (const i of openPlanItems(order_id)) resolveInbox(i.id)
  const project = getProject(project_id)
  if (!project.settings.plan_approval_small && plan.tasks.every(t => t.size === 'S')) {
    log(project_id, 'plan', 'Small plan auto-approved', { order_id })
    return approvePlan(order_id).catch(e => log(project_id, 'error', `Auto-approve failed: ${e.message}`, { order_id }))
  }
  const f = getOrder(order_id).floor
  addInbox(project_id, 'plan', `Plan ready${f === 'tech' ? '' : ` (${floorOf(f)?.name || f})`}: ${plan.summary || getOrder(order_id).text}`, {
    body: plan.tasks.map(t => `- ${t.title} (${t.agent || t.role}, ${t.size || 'M'})`).join('\n'), order_id,
  })
}

// role 'system' marks an order handed over by another floor's lead rather than typed by the owner. No chat_id starts a new chat.
// hotfix: a plan from this message ships without PRs, review or QA.
export async function chat(project_id, text, floor = 'tech', role = 'user', chat_id = newChat(project_id, floor, text), hotfix = false) {
  const msg_id = say(project_id, floor, role, text, null, chat_id)
  if (waiting.get(`${project_id}:${floor}`) > 0) say(project_id, floor, 'orchestrator', 'Queued: I will get to this right after the current request.', null, chat_id)
  else if (ORDER_WORDS.test(text)) say(project_id, floor, 'orchestrator', 'Got it, looking at the repo.', null, chat_id)
  try {
    const r = await ask(project_id, floor, () => withChat(project_id, floor, chat_id, msg_id, text))
    if (!r.ok) throw new Error(r.text || 'session failed')
    const { text: reply, plan } = parseReply(r.text)
    if (!plan?.tasks.length) return void say(project_id, floor, 'orchestrator', reply || '(no answer)', null, chat_id)
    const order_id = insert('orders', { project_id, text, status: 'awaiting_approval', plan, floor, chat_id, hotfix })
    emit('order', project_id, getOrder(order_id))
    say(project_id, floor, 'orchestrator', reply || plan.summary || 'Here is the plan.', order_id)
    log(project_id, 'plan', `Plan proposed: ${plan.summary || text} (${plan.tasks.length} tasks)`, { order_id })
    await offerPlan(project_id, order_id, plan)
  } catch (e) {
    log(project_id, 'error', `Orchestrator failed: ${e.message}`)
    say(project_id, floor, 'orchestrator', `Sorry, that failed: ${e.message.slice(0, 500)}`, null, chat_id)
  }
}

export async function revisePlan(order_id, feedback) {
  const order = getOrder(order_id), pid = order.project_id, floor = order.floor
  if (order.status !== 'awaiting_approval') throw new Error(`Order is ${order.status}, not awaiting approval`)
  say(pid, floor, 'user', `Revise the plan: ${feedback}`, null, chatFor(pid, floor, order_id))
  setOrder(order_id, { status: 'planning' })
  try {
    const r = await ask(pid, floor, `Revise the plan for this order: "${order.text}"

Current plan:
\`\`\`json
${JSON.stringify(order.plan, null, 2)}
\`\`\`

Owner feedback: ${feedback}

Reply with a short summary of what changed, then the full revised plan as one json block in the same format. Keep the same key for every task that did not change.`)
    if (!r.ok) throw new Error(r.text || 'session failed')
    const { text: reply, plan } = parseReply(r.text)
    if (!plan?.tasks.length) {
      setOrder(order_id, { status: 'awaiting_approval' })
      return void say(pid, floor, 'orchestrator', reply || 'No changes to the plan.', order_id)
    }
    setOrder(order_id, { plan, status: 'awaiting_approval' })
    say(pid, floor, 'orchestrator', reply || 'Plan revised.', order_id)
    log(pid, 'plan', `Plan revised (${plan.tasks.length} tasks)`, { order_id })
    await offerPlan(pid, order_id, plan)
  } catch (e) {
    setOrder(order_id, { status: 'awaiting_approval' })
    log(pid, 'error', `Plan revision failed: ${e.message}`, { order_id })
    say(pid, floor, 'orchestrator', `Sorry, revising failed: ${e.message.slice(0, 500)}`, order_id)
  }
}

// Issues are created before task rows exist so the scheduler never dispatches a task without its issue.
export async function approvePlan(order_id, tasks = null) {
  const order = getOrder(order_id), pid = order.project_id
  if (order.status !== 'awaiting_approval') throw new Error(`Order is ${order.status}, not awaiting approval`)
  const plan = tasks ? { ...order.plan, tasks } : order.plan
  if (!plan?.tasks?.length) throw new Error('Plan has no tasks')
  const loop = findCycle(plan.tasks)
  if (loop) throw new Error(`Plan dependencies loop: ${loop.join(' -> ')}. Edit or revise the plan.`)
  // Synchronous status flip so a second approve click fails instead of duplicating tasks.
  setOrder(order_id, { status: 'in_progress', plan })
  for (const i of openPlanItems(order_id)) resolveInbox(i.id)
  log(pid, 'order', `Plan approved: ${plan.summary || order.text}`, { order_id })

  const project = getProject(pid)
  const agents = activeAgents(pid).filter(a => a.floor === order.floor)
  // Older stored plans carry only "role"; new ones name the agent.
  const specs = plan.tasks.map((p, n) => ({
    key: String(p.key || `t${n + 1}`), title: String(p.title || p.key || `Task ${n + 1}`), description: String(p.description || ''),
    plan_agent: p.agent ? String(p.agent) : null,
    role: String(p.role || agents.find(a => a.name === p.agent)?.role || 'custom'), size: ['S', 'M', 'L'].includes(p.size) ? p.size : 'M',
    acceptance: Array.isArray(p.acceptance) ? p.acceptance.map(String) : [],
    files: Array.isArray(p.files) ? p.files.map(String) : [],
    deps: Array.isArray(p.depends_on) ? p.depends_on.map(String) : [],
  }))
  const issues = []
  for (const s of specs) {
    try {
      issues.push(await createIssue(project, {
        title: s.title,
        body: `${s.description}\n\n### Acceptance\n${s.acceptance.map(c => `- [ ] ${c}`).join('\n')}\n\n_Part of: ${plan.summary || order.text}. Planned by Agent Crew._`,
      }))
    } catch (e) { issues.push(null); log(pid, 'error', `Issue for "${s.title}" failed: ${e.message}`, { order_id }) }
  }
  // Rows and their deps are written in one synchronous pass so no tick sees a task without its deps.
  const ids = new Map()
  const rows = specs.map(({ key, deps, ...s }, n) => {
    const t = { project_id: pid, order_id, plan_key: key, ...s, issue_number: issues[n] }
    t.agent_id = matchAgent(agents, t)?.id ?? null
    const id = insert('tasks', t)
    ids.set(key, id)
    return { id, key, deps }
  })
  // "order:3/t2" points at a task of another order. Unknown keys are dropped: a dangling dependency would leave the task planned forever.
  const resolve = (k, own) => {
    if (ids.has(k)) return k === own ? null : ids.get(k)
    const m = /^order:(\d+)\/(.+)$/.exec(k)
    return m ? get('SELECT id FROM tasks WHERE project_id = ? AND order_id = ? AND plan_key = ?', pid, Number(m[1]), m[2])?.id ?? null : null
  }
  for (const r of rows) setTask(r.id, { depends_on: r.deps.map(k => resolve(k, r.key)).filter(Boolean) })
  log(pid, 'order', `${rows.length} tasks created`, { order_id })
  kick()
}

export function rejectPlan(order_id) {
  const order = getOrder(order_id)
  if (!['awaiting_approval', 'planning'].includes(order.status)) throw new Error(`Order is ${order.status}, cannot reject`)
  setOrder(order_id, { status: 'rejected' })
  for (const i of openPlanItems(order_id)) resolveInbox(i.id)
  log(order.project_id, 'order', `Plan rejected: ${order.plan?.summary || order.text}`, { order_id })
}

export async function integrateOrder(order_id) {
  const order = getOrder(order_id), pid = order.project_id
  if (order.status !== 'in_progress') return
  // Claim first so a second caller returns at the guard above.
  setOrder(order_id, { status: 'ready_to_merge' })
  const tasks = all('SELECT * FROM tasks WHERE order_id = ? ORDER BY id', order_id)
  const project = getProject(pid)
  let notes = ''
  const open = tasks.filter(t => t.pr_number && !t.merged)
  const chain = open.length > 1 && chainOrder(open)
  // One PR, or PRs that build on each other, have nothing left to fit together: no Orchestrator round trip.
  if (open.length < 2) notes = 'Single pull request, no integration check needed.'
  else if (chain) {
    const pr = id => `#${tasks.find(t => t.id === id).pr_number}`
    tasks.sort((a, b) => (chain.indexOf(a.id) + 1 || 1e9) - (chain.indexOf(b.id) + 1 || 1e9))
    notes = `These PRs build on each other: ${pr(chain.at(-1))} already contains the others and passed review and QA with them. Merge in this order: ${chain.map(pr).join(', ')}.`
  } else try {
    const diffs = []
    for (const t of tasks.filter(t => t.pr_number && !t.merged)) {
      diffs.push(`## PR #${t.pr_number}: ${t.title} (task ${t.plan_key}, depends on ${t.depends_on.map(id => tasks.find(x => x.id === id)?.plan_key).join(', ') || 'nothing'})\n\n\`\`\`diff\n${await prDiff(project, t.pr_number)}\n\`\`\``)
    }
    let body = diffs.join('\n\n')
    if (body.length > MAX_DIFFS) body = `${body.slice(0, MAX_DIFFS)}\n... truncated`
    const r = await ask(pid, order.floor, `Every task of the order "${order.text}" passed review and QA. Before the owner merges, check that the pull requests fit together: no conflicting changes, no duplicated work, shared contracts (APIs, types, names) match on both sides, nothing from the plan is missing.

Plan:
\`\`\`json
${JSON.stringify(order.plan, null, 2)}
\`\`\`

${body}

Reply with a short plain-language note for the owner, then end with one fenced json block:
\`\`\`json
{"verdict": "ok", "notes": "Merge #12 then #13. They fit together.", "merge_order": [12, 13]}
\`\`\`
Use "verdict": "problems" and explain in notes when something does not fit.`, { kind: 'integrate' })
    const v = r.ok ? parseVerdict(r.text) : null
    notes = v?.notes || (r.ok ? parseReply(r.text).text : `Integration check failed: ${r.text}`)
    if (Array.isArray(v?.merge_order)) tasks.sort((a, b) => (v.merge_order.indexOf(a.pr_number) + 1 || 1e9) - (v.merge_order.indexOf(b.pr_number) + 1 || 1e9))
    if (v?.verdict === 'problems') log(pid, 'warning', `Integration found problems: ${notes.slice(0, 300)}`, { order_id })
  } catch (e) {
    notes = `Integration check failed: ${e.message}`
    log(pid, 'error', notes, { order_id })
  }
  // A chain is restacked at merge time, but a PR that already conflicts with the branch needs the owner before merging.
  const conflicts = []
  for (const t of open) if (await prMergeable(project, t.pr_number).catch(() => null) === 'CONFLICTING') conflicts.push(`#${t.pr_number}`)
  if (conflicts.length) {
    notes += `

${conflicts.join(', ')} conflict${conflicts.length > 1 ? '' : 's'} with ${project.default_branch} and cannot merge as is.`
    log(pid, 'warning', `PRs conflict with ${project.default_branch}: ${conflicts.join(', ')}`, { order_id })
  }
  say(pid, order.floor, 'orchestrator', `All tasks for "${order.plan?.summary || order.text}" are done and ready to merge.\n\n${notes}`, null, chatFor(pid, order.floor, order_id))
  for (const [n, t] of tasks.filter(t => t.pr_number && !t.merged).entries()) {
    addInbox(pid, 'merge', `Merge PR #${t.pr_number}: ${t.title}`, { body: `Merge order ${n + 1}. ${notes}`, link: t.pr_url, order_id, task_id: t.id })
  }
  log(pid, 'order', 'Order ready to merge', { order_id })
}
