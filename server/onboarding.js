import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { get, run, getProject, update, activeAgents, setAgent, addInbox, addMessage, log } from './db.js'
import { emit } from './bus.js'
import { runClaude } from './runner.js'
import { ensureClone, pullDefault, createWorktree, commitAll, changedFiles, pushBranch, pushTo, createPR } from './github.js'
import { FLOORS, TEMPLATES, FLOOR_TEAMS, ONBOARDER, template, createAgent } from './roster.js'
import { parseProposal } from './rules.js'
import { removeAgent } from './scheduler.js'
import { chat } from './orchestrator.js'

// Onboarding: the Onboarding agent interviews the owner in a resumed session, then proposes the office (brief, floors,
// agents). Approving it hires the agents and writes the crew docs: a PR for an existing repo, straight to main for a blank one.

const ALLOWED = ['CLAUDE.md', '.crew/PLAYBOOK.md', '.crew/owned-paths.json', '.crew/BRIEF.md']
const CATALOG = [...TEMPLATES.map(t => ({ ...t, floor: 'tech' })), ...Object.values(FLOOR_TEAMS).flat()]
const keyOf = t => t.key || t.role
const OFFICE = a => !['support', 'onboarding'].includes(a.role)

function setProject(id, fields) {
  update('projects', id, fields)
  emit('project', id, getProject(id))
}

const say = (project_id, role, text) => addMessage(project_id, role, text, null, { channel: 'onboarding' })

export const onboarder = project_id =>
  activeAgents(project_id).find(a => a.role === 'onboarding') || createAgent(project_id, ONBOARDER)

const roster = agents => agents.filter(OFFICE).map(a => `- ${a.name} (${a.floor} floor, ${a.role}): ${a.specialty}`).join('\n') || '(nobody yet)'

const EXAMPLE = `{
  "brief": "## Product\\n...\\n## Users\\n...\\n## Stage and goals\\n...\\n## Stack\\n...\\n## Constraints and preferences\\n...",
  "floors": ["tech", "design"],
  "agents": [
    {"template": "frontend"},
    {"template": "backend"},
    {"template": "product-designer"},
    {"name": "Mobile Dev", "floor": "tech", "role": "mobile", "specialty": "React Native app", "instructions": "Build the mobile app in mobile/. Share API types with the web app.", "owned_paths": ["mobile/**"], "model": "sonnet"}
  ],
  "first_order": null
}`

const SYSTEM = (p, current) => `You are the Onboarding agent of Agent Crew: an office of AI agents (Claude Code sessions) that works on the GitHub repo ${p.repo} for a founder, the owner. Your job is to understand what the owner is building and propose the office that should work on it. Your working directory is a clone of the repo. You only read (Read, Grep, Glob); you never edit files.

How the office works: it has floors. Each floor has a lead that turns the owner's orders into plans, workers that do the tasks as pull requests, and a reviewer. Tech works on the code and also has QA. Other floors write Markdown documents in their own folder of the repo. Leads, reviewers and QA are added automatically for every floor you open; you choose the workers.

Floors:
${FLOORS.map(f => `- ${f.key}: ${f.name}${f.folder ? ` (folder ${f.folder}/)` : ''}. ${f.blurb}`).join('\n')}

Worker templates you can hire, by key:
${CATALOG.filter(t => !['orchestrator', 'reviewer', 'qa', 'support'].includes(t.role)).map(t => `- ${keyOf(t)}: ${t.name}, ${t.floor} floor. ${t.specialty}`).join('\n')}

When no template fits (a mobile developer, a data engineer, an ML engineer), define a custom agent: name, floor, role (one word), specialty, instructions, owned_paths (the repo globs it may edit: code folders for Tech, its floor's folder otherwise), model (opus for hard reasoning, sonnet by default, haiku for simple chores).

${p.source === 'blank'
  ? 'This is a new project. The owner\'s idea or PRD is in docs/PRD.md. Read it first.'
  : 'Read the repo first: README, manifests, source layout, docs, tests, CI. Learn the product, stack and stage from it.'}
${current ? `\nThe owner is re-running onboarding. The office today:\n${current}\nAnything you leave out of the proposal is removed when the owner approves it, so list every agent to keep (by template key, or as a custom agent with its current name and floor).\n` : ''}
Interview:
- Ask at most 3 short numbered questions per reply, only about what the repo cannot tell you: the goal and the users, the stage and deadlines, which areas the owner wants help with now, how lean the office should be (every busy agent costs tokens), roles they already know they want.${p.source === 'blank' ? ' For a new project also agree on the stack, unless the PRD fixes it.' : ''}
- One to three rounds is usually enough. When you know enough, or the owner asks for it, propose. Keep the office lean: only the floors needed now; more can be opened later.
- When the owner asks for changes, reply with the full revised proposal.

Proposal: a short plain-language summary of the office and why, then one fenced json block as the last thing in the reply:
\`\`\`json
${EXAMPLE}
\`\`\`
- "brief" is Markdown that every agent reads before working: product, users, stage, stack, goals for the next weeks, constraints, and the owner's preferences from this chat. 150 to 400 words, facts only.
- "first_order": ${p.source === 'blank' ? 'the first order for the Tech floor: scaffold the agreed stack so it runs, with one passing test and the commands in the README.' : 'null (the repo already exists).'}`

// One interview turn at a time per project.
const queue = new Map()
export function askOnboarding(project_id, text, { auto = false } = {}) {
  if (!auto) say(project_id, 'user', text)
  const p = (queue.get(project_id) || Promise.resolve()).then(() => turn(project_id, text))
  queue.set(project_id, p.catch(() => {}))
  return p
}

const kvGet = key => get('SELECT value FROM kv WHERE key = ?', key)?.value
const kvSet = (key, value) => run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)

async function turn(project_id, text) {
  const a = onboarder(project_id)
  try {
    let project = getProject(project_id)
    if (!project.local_path) await ensureClone(project)
    await pullDefault(getProject(project_id))
    project = getProject(project_id)
    const current = project.rerun ? roster(activeAgents(project_id)) : null
    const key = `onboard:${project_id}`
    const go = resume => runClaude({
      project_id, agent_id: a.id, kind: 'onboarding', cwd: project.local_path, prompt: text, systemPrompt: SYSTEM(project, current),
      model: a.model, effort: a.effort, allowedTools: ['Read', 'Grep', 'Glob'], permissionMode: 'dontAsk', resume,
    })
    let r = await go(kvGet(key) || null)
    if (!r.ok && !r.stopped && kvGet(key)) { run('DELETE FROM kv WHERE key = ?', key); r = await go(null) }
    if (r.session_id) kvSet(key, r.session_id)
    if (!r.ok) throw new Error(String(r.text || 'session failed').slice(0, 500))
    const { text: reply, proposal } = parseProposal(r.text, { floors: FLOORS, templates: CATALOG })
    if (proposal) setProject(project_id, { proposal, onboarding_status: 'proposed' })
    say(project_id, 'onboarding', [reply || (proposal ? 'Here is the office I propose.' : '(no answer)'), ...(proposal?.notes || [])].join('\n\n'))
  } catch (e) {
    log(project_id, 'error', `Onboarding interview failed: ${e.message}`, { agent_id: a.id })
    say(project_id, 'onboarding', `Sorry, that failed: ${e.message}`)
  }
}

// New project or re-run: a fresh session and the first turn without waiting for the owner.
export function startInterview(project_id, { rerun = false } = {}) {
  run('DELETE FROM kv WHERE key = ?', `onboard:${project_id}`)
  onboarder(project_id)
  setProject(project_id, { onboarding_status: 'interviewing', proposal: null, rerun: rerun ? 1 : 0 })
  say(project_id, 'system', rerun ? 'Onboarding re-run started. The Onboarding agent is reading the repo and the brief.' : 'Onboarding started. The Onboarding agent is reading the project.')
  const first = getProject(project_id).source === 'blank'
    ? 'Read docs/PRD.md and start the interview.'
    : rerun ? 'Read the repo and .crew/BRIEF.md if it exists, then start the interview about how the office should change.' : 'Read the repo and start the interview.'
  return askOnboarding(project_id, first, { auto: true })
}

// keep: indexes of proposal.agents the owner left ticked; locked ones are always hired.
export function applyProposal(project_id, keep = []) {
  const project = getProject(project_id)
  if (project.onboarding_status !== 'proposed' || !project.proposal) throw new Error('There is no proposal waiting for approval')
  const prop = project.proposal
  const chosen = prop.agents.filter((a, i) => a.locked || keep.includes(i))
  setProject(project_id, { onboarding_status: 'running' })
  const current = activeAgents(project_id).filter(OFFICE)
  const same = (x, a) => x.name === a.name && x.floor === a.floor
  for (const a of chosen) {
    if (current.some(x => same(x, a))) continue
    const fields = a.template
      ? { ...template(a.template), name: a.name, floor: a.floor }
      : { name: a.name, floor: a.floor, role: a.role, specialty: a.specialty, instructions: a.instructions, owned_paths: a.owned_paths,
          readonly_paths: a.readonly_paths, model: a.model, effort: 'medium', permissions: { open_pr: true, comment: true, run_tests: a.floor === 'tech', merge: false } }
    emit('agent', project_id, createAgent(project_id, fields))
  }
  for (const x of current) if (!chosen.some(a => same(x, a))) removeAgent(x.id)
  log(project_id, 'onboarding', `Office approved: ${chosen.length} agents on ${prop.floors.length} floor(s)`)
  say(project_id, 'system', 'Office approved. Writing CLAUDE.md, the playbook, owned paths and the brief.')
  return writeDocs(project_id)
}

// A re-run reuses nothing from an older branch, so diff from where it forked off the default branch.
const mergeBase = (cwd, ref) => new Promise((ok, fail) =>
  execFile('git', ['merge-base', ref, 'HEAD'], { cwd, windowsHide: true }, (e, out, err) => e ? fail(new Error(err || e.message)) : ok(out.trim())))

const strings = v => Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()) : []

function prompt(agents, brief) {
  const list = agents.map(a => `- ${a.role} (${a.name}): ${a.specialty}; current owned_paths ${JSON.stringify(a.owned_paths)}`).join('\n')
  const roles = [...new Set(agents.map(a => a.role))]
  return `You are onboarding an AI dev crew onto this repository. Read the repo (README, package manifests, source layout, tests, CI config) and then write exactly these three files, nothing else:

1. CLAUDE.md: what the app is, the stack, the exact commands to install, test and build, the architecture (main folders and how they connect), and the coding conventions you observed. If a CLAUDE.md already exists, improve it and keep what is still true. If the repo has no code yet, describe the planned stack from the brief and say the commands come with the scaffold.
2. .crew/PLAYBOOK.md: how the crew works here. Handoffs between roles, branch rules (one branch per task named crew/<task>, never push to the default branch), and the definition of done (acceptance criteria met, tests pass, Reviewer and QA approve, PR opened for a human to merge).
3. .crew/owned-paths.json: a JSON object mapping every role below to the globs it may edit and read, based on the real layout of this repo (or the planned layout if it is empty):
   { "<role>": { "owned_paths": ["..."], "readonly_paths": ["..."] } }
   Roles: ${roles.join(', ')}. Roles that never edit code (orchestrator, reviewer, qa) get owned_paths []. Owned paths of different roles should not overlap. Use forward slashes and globs like "src/**".

The Tech roster:
${list}

The project brief the owner approved (.crew/BRIEF.md, already written):
${brief || '(none)'}

Do not edit any other file. Do not run git. Reply with a short summary of what you found.`
}

async function writeDocs(project_id) {
  let project = getProject(project_id)
  try {
    await ensureClone(project)
    project = getProject(project_id)
    await pullDefault(project)
    const branch = `crew/onboarding-${Date.now().toString(36)}`
    const { path } = await createWorktree(project, branch)
    // Other floors own their fixed folders; the writer maps the code layout for Tech only.
    const agents = activeAgents(project_id).filter(a => a.floor === 'tech' && OFFICE(a))
    const lead = agents.find(a => a.role === 'orchestrator')
    const brief = project.proposal?.brief || ''
    if (brief) {
      mkdirSync(join(path, '.crew'), { recursive: true })
      writeFileSync(join(path, '.crew', 'BRIEF.md'), `${brief.trim()}\n`)
    }

    const r = await runClaude({
      project_id, agent_id: onboarder(project_id).id, kind: 'onboarding', cwd: path,
      prompt: prompt(agents, brief),
      systemPrompt: `${lead?.instructions || ''}\nFor this onboarding session only, you may write CLAUDE.md, .crew/PLAYBOOK.md and .crew/owned-paths.json.`,
      model: 'opus', effort: 'high',
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], permissionMode: 'acceptEdits',
    })
    if (!r.ok) throw new Error(`Onboarding session failed: ${r.text}`)

    await commitAll(path, 'Crew onboarding: CLAUDE.md, playbook, owned paths, brief')
    const files = await changedFiles(path, await mergeBase(path, `origin/${project.default_branch}`))
    if (!files.length) throw new Error('Onboarding changed no files')
    const bad = files.filter(f => !ALLOWED.includes(f))
    if (bad.length) throw new Error(`Onboarding touched files outside its gate: ${bad.join(', ')}`)

    let proposed = {}
    try { proposed = JSON.parse(readFileSync(join(path, '.crew', 'owned-paths.json'), 'utf8')) } catch (e) {
      throw new Error(`.crew/owned-paths.json is missing or not valid JSON: ${e.message}`)
    }
    for (const a of agents) {
      const p = proposed?.[a.role]
      if (p && typeof p === 'object') setAgent(a.id, { owned_paths: strings(p.owned_paths), readonly_paths: strings(p.readonly_paths) })
    }

    // A blank repo has nothing to review against yet: the docs go straight to the default branch.
    if (project.source === 'blank' && !project.rerun) {
      await pushTo(path, `HEAD:${project.default_branch}`)
      setProject(project_id, { onboarding_status: 'done' })
      log(project_id, 'onboarding', 'Crew docs pushed to the default branch')
      say(project_id, 'system', 'Done. CLAUDE.md, the playbook and the brief are on the default branch.')
      if (project.proposal?.first_order) {
        say(project_id, 'system', 'The first order went to the Tech floor. Its plan waits for your approval in Command.')
        chat(project_id, project.proposal.first_order, 'tech', 'system').catch(e => log(project_id, 'error', `First order failed: ${e.message}`))
      }
      return
    }
    await pushBranch(path, branch)
    const pr = await createPR(project, {
      branch, title: project.rerun ? 'Crew onboarding (re-run)' : 'Crew onboarding',
      body: `Adds CLAUDE.md, .crew/PLAYBOOK.md, .crew/owned-paths.json and .crew/BRIEF.md so the crew knows this repo.\n\n${r.text}`,
    })
    setProject(project_id, { onboarding_pr: pr.number, onboarding_status: 'pr_open' })
    addInbox(project_id, 'merge', 'Merge the crew onboarding PR', { body: 'Review CLAUDE.md, the playbook, the brief and the owned paths, then merge.', link: pr.url })
    log(project_id, 'onboarding', `Onboarding PR #${pr.number} opened`, { link: pr.url })
    say(project_id, 'system', `Onboarding PR #${pr.number} is open. Merge it from the Inbox to finish.`)
  } catch (e) {
    setProject(project_id, { onboarding_status: 'failed' })
    log(project_id, 'error', `Onboarding failed: ${e.message}`)
    say(project_id, 'system', `Onboarding failed: ${e.message.slice(0, 500)}. Re-run onboarding from Projects.`)
  }
}
