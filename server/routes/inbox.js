// Needs you: inbox items, their actions, and the activity log. Mounted by server/index.js behind the owner cookie check.
import express from 'express'
import { all, get, getProject, getTask, getOrder, resolveInbox } from '../db.js'
import { mergePR } from '../github.js'
import { chat, chatFor, revisePlan, approvePlan, rejectPlan } from '../orchestrator.js'
import { mergeTask, markOnboarded, resolveConflicts } from '../scheduler.js'
import { answerFromOwner } from '../crewmcp.js'
import { fail, int, found, str, background, project } from '../http.js'
import { answer } from './runs.js'
import { retryTask } from './orders.js'

const app = express.Router()
export default app

// Inbox

app.get('/api/projects/:id/inbox', (req, res) => {
  const p = project(req), { status } = req.query
  if (status && status !== 'open' && status !== 'done') throw fail(400, 'status must be open or done')
  res.json(status
    ? all(`SELECT * FROM inbox WHERE project_id = ? AND status = ? ORDER BY id ${status === 'open' ? 'ASC' : 'DESC'}`, p.id, status)
    : all('SELECT * FROM inbox WHERE project_id = ? ORDER BY id DESC', p.id))
})

app.post('/api/inbox/:id/action', async (req, res) => {
  const item = found(get('SELECT * FROM inbox WHERE id = ?', int(req.params.id)), 'inbox item')
  if (item.status !== 'open') throw fail(409, 'already resolved')
  const { action, text, remember } = req.body ?? {}
  const key = `${item.kind}:${action}`
  let status = 200
  if (item.kind === 'permission') {
    if (!['allow', 'deny', 'dismiss'].includes(action)) throw fail(400, `unknown action ${action} for permission`)
    // A run that already ended leaves nothing to answer; the item still closes.
    try { answer(item.run_id, item.ref, action === 'allow', { message: typeof text === 'string' && text.trim() ? text : undefined, remember: remember === true }) }
    catch (e) { if (e.status !== 400) resolveInbox(item.id); throw e }
  } else if (action === 'dismiss' && item.kind !== 'plan') {
    // nothing to run
  } else if (key === 'plan:approve') await approvePlan(found(item.order_id, 'order'))
  else if (key === 'plan:reject') await rejectPlan(found(item.order_id, 'order'))
  else if (key === 'plan:revise') {
    background(item.project_id, revisePlan(found(item.order_id, 'order'), str(text, 'text')))
    status = 202
  } else if (key === 'merge:merge') {
    const p = getProject(item.project_id)
    if (item.task_id) {
      try { await mergeTask(found(getTask(item.task_id), 'task').id) } catch (e) { throw fail(409, e.message) }
    } else {
      await mergePR(p, found(p.onboarding_pr, 'onboarding pull request'))
      markOnboarded(p.id)
    }
  } else if (key === 'question:answer') {
    // Agent questions go back to the agent; anything else is a note for the Orchestrator.
    if (!answerFromOwner(item, str(text, 'text'))) {
      const floor = (item.order_id && getOrder(item.order_id)?.floor) || 'tech'
      background(item.project_id, chat(item.project_id, `Answer to "${item.title}": ${text}`, floor, 'user', chatFor(item.project_id, floor, item.order_id)))
      status = 202
    }
  } else if (key === 'merge:resolve') {
    try { resolveConflicts(found(getTask(item.task_id), 'task').id) } catch (e) { throw fail(409, e.message) }
  } else if (key === 'failure:retry') retryTask(found(item.task_id, 'task'), typeof text === 'string' ? text.trim().slice(0, 4000) : undefined)
  else throw fail(400, `unknown action ${action} for ${item.kind}`)
  resolveInbox(item.id)
  res.status(status).json({ ok: true })
})

app.get('/api/projects/:id/activity', (req, res) => {
  const p = project(req), limit = req.query.limit ? int(req.query.limit) : 100
  res.json(all('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?', p.id, Math.min(limit, 1000)))
})
