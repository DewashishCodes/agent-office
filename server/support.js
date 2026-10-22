import { all, get, run, getProject, activeAgents, addMessage, log } from './db.js'
import { runClaude, liveRuns, canDeliver, sendToRun } from './runner.js'
import { ensureClone } from './github.js'
import { createAgent, template } from './roster.js'
import { supportPolicy } from './rules.js'
import { denyRules } from './scheduler.js'

// Support: the crew's help desk for chores (run, check, query, look things up). No plan, no worktree, no PR, no review.
// It works in the main clone, never edits code, and keeps one conversation per project by resuming its session.

export const SUPPORT_TOOLS = ['service_start', 'service_stop', 'service_list', 'service_logs', 'suggest_order', 'vault_search', 'vault_read', 'crew_task_status']
const NO_CODE = ['Edit', 'Write', 'NotebookEdit', 'Bash(git commit*)', 'Bash(git push*)', 'Bash(git reset*)', 'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git rebase*)', 'Bash(git merge*)']

const SYSTEM = (a, p) => `You are ${a.name}, the support desk of an AI dev crew working on the GitHub repo ${p.repo}. Your working directory is the main clone on ${p.default_branch}.
You handle chores for the owner so the build team does not have to: run checks and tests, start or stop dev servers, read logs, look things up in the code, and query databases.

Rules:
- Never edit, create or delete code or config files, and never commit. If a request needs a code change, say so in one line and call suggest_order with a clear, self-contained order for the build team. The owner decides whether to send it.
- Long-running processes (dev servers, watchers) go through service_start, never through Bash: a process started in Bash dies with your session. Check service_list first; use service_logs to see output and errors.
- Read-only commands and read-only SQL run straight away. Anything that changes state (installs, writes to a database, killing processes, deleting files) waits for the owner's approval: run the exact command they asked for, do not look for a way around a denial.
- Be brief and concrete: the answer, the numbers, the URL, the error line. No preamble, no summary of what you are about to do. Look only at what the question needs.
${a.instructions ? `\nNotes from the owner:\n${a.instructions}` : ''}`

// Every project has one Support agent; projects from before it existed get one on first use.
export function supportAgent(project_id) {
  return activeAgents(project_id).find(a => a.role === 'support') || createAgent(project_id, template('support'))
}

// At boot, so the Support desk is in the office before the first question.
export function ensureSupport() {
  for (const p of all('SELECT id FROM projects')) supportAgent(p.id)
}

const suggestions = new Map()   // run_id -> order text suggested with suggest_order
export function suggestOrder(ctx, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required')
  suggestions.set(ctx.run_id, text.trim().slice(0, 4000))
  return 'Saved. The owner sees a button to send this to the build team.'
}

const kvGet = key => get('SELECT value FROM kv WHERE key = ?', key)?.value
const kvSet = (key, value) => run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
const say = (project_id, text, extra = {}) => addMessage(project_id, 'support', text, null, { channel: 'support', ...extra })

export async function askSupport(project_id, text, { model } = {}) {
  addMessage(project_id, 'user', text, null, { channel: 'support' })
  const project = getProject(project_id)
  if (project.paused) return say(project_id, 'The kill switch is on, so I am not running anything. Resume the crew first.')
  const a = supportAgent(project_id)
  if (a.status === 'paused') return say(project_id, `${a.name} is paused. Resume it on the Team page.`)
  // Already on it: the message joins the running session and is answered in the same reply.
  const busy = liveRuns().find(r => r.agent_id === a.id && r.kind === 'support')
  if (busy && canDeliver(busy.run_id)) return sendToRun(busy.run_id, text)

  if (!project.local_path) await ensureClone(project)
  const p = getProject(project_id)
  const key = `support:${project_id}`
  const go = resume => runClaude({
    project_id, agent_id: a.id, kind: 'support', cwd: p.local_path, prompt: text, systemPrompt: SYSTEM(a, p),
    model: model || a.model, effort: a.effort, permissionMode: 'default', resume,
    disallowedTools: [...denyRules(p), ...NO_CODE], allowedTools: SUPPORT_TOOLS.map(t => `mcp__crew__${t}`), mcp: SUPPORT_TOOLS,
    permissionPolicy: (tool, input) => supportPolicy(p.settings, tool, input, p.local_path),
  })
  let r = await go(kvGet(key) || null)
  // A session that cannot be resumed (cleaned up, moved) starts over rather than failing the owner's question.
  if (!r.ok && !r.stopped && kvGet(key)) { run('DELETE FROM kv WHERE key = ?', key); r = await go(null) }
  if (r.session_id) kvSet(key, r.session_id)
  const suggest = suggestions.get(r.run_id) || null
  suggestions.delete(r.run_id)
  if (r.stopped) return say(project_id, 'Stopped.')
  if (!r.ok) {
    log(project_id, 'error', `Support failed: ${String(r.text).slice(0, 300)}`, { agent_id: a.id })
    return say(project_id, `I could not finish that: ${String(r.text).slice(0, 600)}`)
  }
  say(project_id, r.text || '(done)', { suggest })
}
