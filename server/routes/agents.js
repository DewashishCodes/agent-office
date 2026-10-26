// Agents, templates and floors. Mounted by server/index.js behind the owner cookie check.
import express from 'express'
import { all, get, insert, activeAgents, setAgent, log } from '../db.js'
import { emit } from '../bus.js'
import { TEMPLATES, FLOORS, FLOOR_TEAMS, floorOf, template, createAgent, openFloor } from '../roster.js'
import { tokensToday } from '../runner.js'
import { removeAgent, pauseAgent, resumeAgent } from '../scheduler.js'
import { fail, found, isObj, isStrs, str, project, agent, floorKey } from '../http.js'

const app = express.Router()
export default app

const EDITABLE = {
  name: v => typeof v === 'string' && v.trim() !== '',
  specialty: v => typeof v === 'string',
  instructions: v => typeof v === 'string',
  model: v => typeof v === 'string' && v !== '',
  effort: v => typeof v === 'string' && v !== '',
  owned_paths: isStrs,
  readonly_paths: isStrs,
  permissions: v => isObj(v) && Object.values(v).every(b => typeof b === 'boolean'),
  max_parallel: v => Number.isInteger(v) && v >= 1,
  daily_token_budget: v => Number.isInteger(v) && v >= 0,
}

function profileFields(body) {
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE[k]) throw fail(400, `${k} is not editable`)
    if (!EDITABLE[k](v)) throw fail(400, `invalid ${k}`)
  }
  return body
}

// Agents

app.get('/api/templates', (req, res) => res.json([...TEMPLATES.map(t => ({ ...t, floor: 'tech' })), ...Object.values(FLOOR_TEAMS).flat()]))

app.get('/api/floors', (req, res) => res.json(FLOORS))

// Opening a floor hires its lead, workers and reviewer.
app.post('/api/projects/:id/floors', (req, res) => {
  const p = project(req), key = floorKey(req.body?.floor)
  if (!FLOOR_TEAMS[key]) throw fail(400, 'That floor is always open')
  if (activeAgents(p.id).some(a => a.floor === key)) throw fail(409, `The ${floorOf(key).name} floor is already open`)
  const hired = openFloor(p.id, key)
  for (const a of hired) emit('agent', p.id, a)
  log(p.id, 'floor', `${floorOf(key).name} floor opened with ${hired.map(a => a.name).join(', ')}`)
  res.json(hired)
})

// The live run's last event, and whether it waits on the owner (the floor switcher pulses for that floor).
function running(agentId) {
  const r = get("SELECT last_event, pending_permission FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY id DESC", agentId)
  return { last_event: r?.last_event ?? null, asking: !!r?.pending_permission?.length }
}

app.get('/api/projects/:id/agents', (req, res) => {
  res.json(activeAgents(project(req).id).map(a => ({
    ...a,
    tokens_today: tokensToday(a.id),
    current_task: get("SELECT title FROM tasks WHERE agent_id = ? AND status = 'in_progress' ORDER BY id DESC", a.id)?.title ?? null,
    ...running(a.id),
  })))
})

app.post('/api/projects/:id/agents', (req, res) => {
  const p = project(req)
  const { role, floor, ...fields } = req.body ?? {}
  profileFields(fields)
  let base = { role: 'custom' }
  if (role !== undefined && role !== 'custom') base = found(template(role), 'template')
  const a = { ...base, ...fields }
  if (floor !== undefined || !a.floor) a.floor = floorKey(floor)
  str(a.name, 'name')
  const out = createAgent(p.id, a)
  emit('agent', p.id, out)
  res.json(out)
})

app.get('/api/agents/:id', (req, res) => {
  const a = agent(req)
  res.json({
    ...a,
    notes: all('SELECT * FROM agent_notes WHERE agent_id = ? ORDER BY id DESC', a.id),
    tasks: all('SELECT * FROM tasks WHERE agent_id = ? ORDER BY id DESC LIMIT 20', a.id),
    runs: all('SELECT * FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 10', a.id),
  })
})

app.patch('/api/agents/:id', (req, res) => res.json(setAgent(agent(req).id, profileFields(req.body ?? {}))))

app.post('/api/agents/:id/clone', (req, res) => {
  const a = agent(req)
  let n = 2
  while (get('SELECT 1 FROM agents WHERE project_id = ? AND name = ? AND removed_at IS NULL', a.project_id, `${a.name} ${n}`)) n++
  const copy = { role: a.role, floor: a.floor }
  for (const k of Object.keys(EDITABLE)) copy[k] = a[k]
  const out = createAgent(a.project_id, { ...copy, name: `${a.name} ${n}` })
  emit('agent', a.project_id, out)
  res.json(out)
})

app.post('/api/agents/:id/pause', async (req, res) => res.json(await pauseAgent(agent(req).id)))

app.post('/api/agents/:id/resume', (req, res) => res.json(resumeAgent(agent(req).id)))

app.delete('/api/agents/:id', (req, res) => {
  const a = agent(req)
  if (!a.removable) throw fail(400, `${a.name} cannot be removed`)
  // Every PR goes through its floor's reviewer (and QA on Tech), so the last one of each on a floor stays.
  if (['reviewer', 'qa'].includes(a.role) && activeAgents(a.project_id).filter(x => x.role === a.role && x.floor === a.floor).length < 2)
    throw fail(400, `${a.name} is the only ${a.role} agent on this floor. Add another one first, or pause it instead.`)
  res.json(removeAgent(a.id))
})

app.post('/api/agents/:id/notes', (req, res) => {
  const a = agent(req)
  const id = insert('agent_notes', { agent_id: a.id, text: str(req.body?.text, 'text') })
  res.json(get('SELECT * FROM agent_notes WHERE id = ?', id))
})
