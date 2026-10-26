// Chats, orders, tasks and the Home wall. Mounted by server/index.js behind the owner cookie check.
import express from 'express'
import { all, get, run, insert, getProject, getTask, getOrder, activeAgents, setTask, log } from '../db.js'
import { emit } from '../bus.js'
import { floorOf } from '../roster.js'
import { tokensToday } from '../runner.js'
import { prDiff } from '../github.js'
import { chat, newChat, revisePlan, approvePlan, rejectPlan } from '../orchestrator.js'
import { kick, mergeTask, cancelOrder, cancelTask, resolveConflicts } from '../scheduler.js'
import { matchAgent, estimates } from '../rules.js'
import { fail, int, found, isObj, isStrs, str, background, project, agent, floorKey, ORDER_COST } from '../http.js'

const app = express.Router()
export default app

// A retry goes ahead without dependencies the owner canceled; they would never finish. A note from the owner keeps
// the last failure with it, so the agent sees both what went wrong and how the owner wants it fixed.
export function retryTask(id, note) {
  const old = getTask(id)
  const deps = old.depends_on.filter(d => getTask(d)?.status !== 'canceled')
  const notes = note ? `${old.notes ? `${old.notes}\n\n` : ''}From the owner: ${note}` : ''
  const t = setTask(id, { attempts: 0, notes, status: 'planned', depends_on: deps })
  kick()
  return t
}

// Chat and orders

app.get('/api/projects/:id/chats', (req, res) => res.json(all(`SELECT c.*, (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) messages,
  EXISTS (SELECT 1 FROM orders WHERE chat_id = c.id AND status = 'awaiting_approval') pending_plan
  FROM chats c WHERE project_id = ? AND floor = ? ORDER BY updated_at DESC, id DESC LIMIT 100`, project(req).id, floorKey(req.query.floor))))

app.get('/api/projects/:id/messages', (req, res) => {
  if (req.query.chat) return res.json(all('SELECT * FROM messages WHERE project_id = ? AND chat_id = ? ORDER BY id', project(req).id, int(req.query.chat)))
  const support = req.query.channel === 'support'
  res.json(all(`SELECT * FROM (SELECT * FROM messages WHERE project_id = ? AND channel = ?${support ? '' : ' AND floor = ?'} ORDER BY id DESC LIMIT 200) ORDER BY id`,
    project(req).id, ...(support ? ['support'] : ['command', floorKey(req.query.floor)])))
})

app.post('/api/projects/:id/messages', (req, res) => {
  const p = project(req), floor = floorKey(req.body?.floor)
  if (!activeAgents(p.id).some(a => a.floor === floor && a.role === 'orchestrator')) throw fail(400, `The ${floorOf(floor).name} floor has no lead. Open the floor first.`)
  const text = str(req.body?.text, 'text')
  // Without chat_id the message starts a new chat; its id goes back so the screen can follow it.
  const chat_id = req.body?.chat_id == null ? newChat(p.id, floor, text)
    : found(get('SELECT id FROM chats WHERE id = ? AND project_id = ? AND floor = ?', int(req.body.chat_id), p.id, floor), 'chat').id
  background(p.id, chat(p.id, text, floor, 'user', chat_id, req.body?.hotfix === true))
  res.status(202).json({ ok: true, chat_id })
})

app.get('/api/projects/:id/orders', (req, res) => res.json(all(`SELECT o.*, ${ORDER_COST},
  (SELECT COUNT(*) FROM tasks WHERE order_id = o.id) total, (SELECT COUNT(*) FROM tasks WHERE order_id = o.id AND status = 'done') done
  FROM orders o WHERE project_id = ? ORDER BY id DESC`, project(req).id)))

const order = req => found(getOrder(int(req.params.id)), 'order')

app.get('/api/orders/:id', (req, res) => {
  const o = order(req)
  // A plan waiting for approval gets estimates per size from this project's finished tasks.
  const est = o.status === 'awaiting_approval' && estimates(all(`SELECT t.size, SUM(r.input_tokens + r.output_tokens) tokens, SUM(r.cost_usd) cost
    FROM tasks t JOIN runs r ON r.task_id = t.id WHERE t.project_id = ? AND (t.status = 'done' OR t.merged = 1) GROUP BY t.id`, o.project_id))
  res.json({ ...get(`SELECT ${ORDER_COST} FROM orders o WHERE id = ?`, o.id), ...o, estimates: est || null, tasks: all('SELECT * FROM tasks WHERE order_id = ? ORDER BY id', o.id) })
})

app.post('/api/orders/:id/approve', async (req, res) => {
  const o = order(req), tasks = req.body?.tasks
  if (tasks != null && !(Array.isArray(tasks) && tasks.every(isObj))) throw fail(400, 'tasks must be an array of objects')
  await approvePlan(o.id, tasks ?? null)
  res.json({ ok: true })
})

app.post('/api/orders/:id/revise', (req, res) => {
  const o = order(req)
  background(o.project_id, revisePlan(o.id, str(req.body?.feedback, 'feedback')))
  res.status(202).json({ ok: true })
})

app.post('/api/orders/:id/cancel', (req, res) => {
  const o = order(req)
  if (['done', 'rejected', 'canceled'].includes(o.status)) throw fail(409, `That order is already ${o.status}`)
  cancelOrder(o.id)
  res.json({ ok: true })
})

// Merge every PR of the order in the order the integration check asked for (its merge cards), stopping at the first failure.
app.post('/api/orders/:id/merge', async (req, res) => {
  const o = order(req)
  const cards = all(`SELECT task_id FROM inbox WHERE order_id = ? AND kind = 'merge' AND task_id IS NOT NULL ORDER BY id`, o.id).map(i => i.task_id)
  const tasks = all('SELECT id FROM tasks WHERE order_id = ? AND pr_number IS NOT NULL AND merged = 0 AND status = ? ORDER BY id', o.id, 'done').map(t => t.id)
  const ordered = [...cards.filter(id => tasks.includes(id)), ...tasks.filter(id => !cards.includes(id))]
  const merged = []
  for (const id of ordered) {
    try { await mergeTask(id); merged.push(id) } catch (e) {
      return res.status(409).json({ error: `Merged ${merged.length} of ${ordered.length}. "${getTask(id).title}" failed: ${e.message}`, merged })
    }
  }
  res.json({ merged })
})

app.post('/api/orders/:id/reject', async (req, res) => {
  await rejectPlan(order(req).id)
  res.json({ ok: true })
})

// Tasks

// What the office delivered: merged tasks newest first, each with its agent, order and total run cost.
app.get('/api/projects/:id/shipped', (req, res) => {
  res.json(all(`SELECT t.id, t.title, t.pr_number, t.pr_url, t.order_id, COALESCE(t.merged_at, t.updated_at) merged_at, a.name agent_name,
    COALESCE(o.plan ->> '$.summary', o.text) order_title,
    (SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE task_id = t.id) cost_usd,
    (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM runs WHERE task_id = t.id) tokens
    FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN orders o ON o.id = t.order_id
    WHERE t.project_id = ? AND t.merged = 1 ORDER BY merged_at DESC, t.id DESC LIMIT 300`, project(req).id))
})

app.get('/api/projects/:id/tasks', (req, res) => {
  const p = project(req), { agent_id, order_id } = req.query
  let sql = 'SELECT t.*, a.name agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.project_id = ?'
  const params = [p.id]
  if (agent_id) sql += ' AND t.agent_id = ?', params.push(int(agent_id))
  if (order_id) sql += ' AND t.order_id = ?', params.push(int(order_id))
  res.json(all(sql + ' ORDER BY t.id', ...params))
})

// Direct task: a one-task order for a named agent, no plan round trip. Reviewer and QA still run, unless it is a hotfix.
app.post('/api/projects/:id/tasks', (req, res) => {
  const p = project(req)
  const { agent: name, title, description = '', acceptance = [], files = [], hotfix = false } = req.body ?? {}
  str(title, 'title')
  if (typeof description !== 'string' || !isStrs(acceptance) || !isStrs(files)) throw fail(400, 'description must be text, acceptance and files lists of text')
  const a = activeAgents(p.id).find(x => x.name === str(name, 'agent'))
  if (!a?.owned_paths.length) throw fail(400, `${name} is not an agent that owns paths`)
  if (!matchAgent([a], { files })) throw fail(400, `${a.name} does not own ${files.join(', ')}`)
  const spec = { key: 't1', title, agent: a.name, description, acceptance, files, size: 'S', depends_on: [] }
  const order_id = insert('orders', { project_id: p.id, text: title, status: 'in_progress', plan: { summary: title, direct: true, tasks: [spec] }, hotfix: hotfix === true })
  const task_id = insert('tasks', { project_id: p.id, order_id, plan_key: 't1', title, description, role: a.role, plan_agent: a.name, acceptance, files, size: 'S', agent_id: a.id })
  emit('order', p.id, getOrder(order_id))
  log(p.id, 'order', `${hotfix === true ? 'Hotfix' : 'Quick task'} for ${a.name}: ${title}`, { order_id, task_id, agent_id: a.id })
  const t = setTask(task_id, {})
  kick()
  res.json(t)
})

app.get('/api/tasks/:id', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  res.json({
    ...t,
    activity: all('SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC', t.id),
    runs: all('SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC', t.id),
  })
})

app.get('/api/tasks/:id/diff', async (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  if (!t.pr_number) throw fail(404, 'This task has no pull request yet')
  try { res.json({ diff: await prDiff(getProject(t.project_id), t.pr_number) }) } catch (e) { throw fail(502, e.message) }
})

app.post('/api/tasks/:id/resolve', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  try { res.json(resolveConflicts(t.id)) } catch (e) { throw fail(409, e.message) }
})

app.post('/api/tasks/:id/cancel', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  try { res.json(cancelTask(t.id)) } catch (e) { throw fail(409, e.message) }
})

app.post('/api/tasks/:id/retry', (req, res) => {
  const t = found(getTask(int(req.params.id)), 'task')
  const note = req.body?.note
  if (note !== undefined && typeof note !== 'string') throw fail(400, 'note must be text')
  res.json(retryTask(t.id, note?.trim().slice(0, 4000)))
})

// Wall: one request to boot the screen, SSE after that.

export const crewFeed = (project_id, limit = 50) => all(`SELECT * FROM (
  SELECT m.*, f.name from_name, t.name to_name FROM crew_messages m
  LEFT JOIN agents f ON f.id = m.from_agent_id LEFT JOIN agents t ON t.id = m.to_agent_id
  WHERE m.project_id = ? ORDER BY m.id DESC LIMIT ?) ORDER BY id`, project_id, limit)

app.get('/api/projects/:id/wall', (req, res) => {
  const p = project(req)
  // shortcut: one tile per agent shows its newest run; a reviewer running two checks shows only the latest.
  const agents = activeAgents(p.id).map(a => ({
    ...a,
    tokens_today: tokensToday(a.id),
    run: get(`SELECT r.*, t.title task_title FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.agent_id = ? ORDER BY r.status = 'running' DESC, r.id DESC`, a.id) ?? null,
  }))
  const orders = all(`SELECT o.*, ${ORDER_COST} FROM orders o WHERE project_id = ? AND status NOT IN ('done', 'rejected', 'canceled') ORDER BY id DESC`, p.id).map(o => ({
    ...o, counts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM tasks WHERE order_id = ? GROUP BY status', o.id).map(c => [c.status, c.n])),
  }))
  const permissions = all(`SELECT r.id run_id, r.pending_permission, a.name agent_name FROM runs r LEFT JOIN agents a ON a.id = r.agent_id
    WHERE r.project_id = ? AND r.status = 'running' AND r.pending_permission IS NOT NULL`, p.id)
  res.json({ agents, orders, permissions, crew: crewFeed(p.id) })
})
