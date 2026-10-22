import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProject, update, activeAgents, setAgent, addInbox, log } from './db.js'
import { emit } from './bus.js'
import { runClaude } from './runner.js'
import { ensureClone, pullDefault, createWorktree, commitAll, changedFiles, pushBranch, createPR, prState } from './github.js'

const BRANCH = 'crew/onboarding'
const ALLOWED = ['CLAUDE.md', '.crew/PLAYBOOK.md', '.crew/owned-paths.json']

function setProject(id, fields) {
  update('projects', id, fields)
  emit('project', id, getProject(id))
}

// A re-run reuses the branch, so diff from where it forked off the default branch, not from its HEAD.
const mergeBase = (cwd, ref) => new Promise((ok, fail) =>
  execFile('git', ['merge-base', ref, 'HEAD'], { cwd, windowsHide: true }, (e, out, err) => e ? fail(new Error(err || e.message)) : ok(out.trim())))

const strings = v => Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()) : []

function prompt(agents) {
  const roster = agents.map(a => `- ${a.role} (${a.name}): ${a.specialty}; current owned_paths ${JSON.stringify(a.owned_paths)}`).join('\n')
  const roles = [...new Set(agents.map(a => a.role))]
  return `You are onboarding an AI dev crew onto this repository. Read the repo (README, package manifests, source layout, tests, CI config) and then write exactly these three files, nothing else:

1. CLAUDE.md: what the app is, the stack, the exact commands to install, test and build, the architecture (main folders and how they connect), and the coding conventions you observed. If a CLAUDE.md already exists, improve it and keep what is still true.
2. .crew/PLAYBOOK.md: how the crew works here. Handoffs between roles, branch rules (one branch per task named crew/<task>, never push to the default branch), and the definition of done (acceptance criteria met, tests pass, Reviewer and QA approve, PR opened for a human to merge).
3. .crew/owned-paths.json: a JSON object mapping every role below to the globs it may edit and read, based on the real layout of this repo:
   { "<role>": { "owned_paths": ["..."], "readonly_paths": ["..."] } }
   Roles: ${roles.join(', ')}. Roles that never edit code (orchestrator, reviewer, qa) get owned_paths []. Owned paths of different roles should not overlap. Use forward slashes and globs like "src/**".

The roster:
${roster}

Do not edit any other file. Do not run git. Reply with a short summary of what you found.`
}

export async function runOnboarding(project_id) {
  let project = getProject(project_id)
  setProject(project_id, { onboarding_status: 'running' })
  log(project_id, 'onboarding', 'Onboarding started')
  try {
    await ensureClone(project)
    project = getProject(project_id)
    await pullDefault(project)
    const { path } = await createWorktree(project, BRANCH)
    // Owned paths of other floors are their fixed folders; onboarding maps the code layout for the Tech floor only.
    const agents = activeAgents(project_id).filter(a => a.floor === 'tech')
    const lead = agents.find(a => a.role === 'orchestrator')

    const r = await runClaude({
      project_id, agent_id: lead?.id ?? null, kind: 'onboarding', cwd: path,
      prompt: prompt(agents),
      systemPrompt: `${lead?.instructions || ''}\nFor this onboarding session only, you may write CLAUDE.md, .crew/PLAYBOOK.md and .crew/owned-paths.json.`,
      model: lead?.model, effort: lead?.effort,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], permissionMode: 'acceptEdits',
    })
    if (!r.ok) throw new Error(`Onboarding session failed: ${r.text}`)

    await commitAll(path, 'Crew onboarding: CLAUDE.md, playbook, owned paths')
    const files = await changedFiles(path, await mergeBase(path, `origin/${project.default_branch}`))
    if (!files.length) throw new Error('Onboarding changed no files')
    const bad = files.filter(f => !ALLOWED.includes(f))
    if (bad.length) throw new Error(`Onboarding touched files outside its gate: ${bad.join(', ')}`)

    let proposed = {}
    try { proposed = JSON.parse(readFileSync(join(path, '.crew', 'owned-paths.json'), 'utf8')) } catch (e) {
      throw new Error(`.crew/owned-paths.json is missing or not valid JSON: ${e.message}`)
    }

    await pushBranch(path, BRANCH)
    let pr = null
    if (project.onboarding_pr && (await prState(project, project.onboarding_pr).catch(() => null))?.state === 'OPEN')
      pr = { number: project.onboarding_pr, url: `https://github.com/${project.repo}/pull/${project.onboarding_pr}` }
    else pr = await createPR(project, {
      branch: BRANCH, title: 'Crew onboarding',
      body: `Adds CLAUDE.md, .crew/PLAYBOOK.md and .crew/owned-paths.json so the crew knows this repo.\n\n${r.text}`,
    })

    for (const a of agents) {
      const p = proposed?.[a.role]
      if (p && typeof p === 'object') setAgent(a.id, { owned_paths: strings(p.owned_paths), readonly_paths: strings(p.readonly_paths) })
    }

    setProject(project_id, { onboarding_pr: pr.number, onboarding_status: 'pr_open' })
    addInbox(project_id, 'merge', 'Merge the crew onboarding PR', { body: 'Review CLAUDE.md, the playbook and the proposed owned paths, then merge.', link: pr.url })
    log(project_id, 'onboarding', `Onboarding PR #${pr.number} opened`, { agent_id: lead?.id ?? null, link: pr.url })
  } catch (e) {
    setProject(project_id, { onboarding_status: 'failed' })
    log(project_id, 'error', `Onboarding failed: ${e.message}`)
  }
}
