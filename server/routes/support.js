// Support desk and the services it starts. Mounted by server/index.js behind the owner cookie check.
import express from 'express'
import { get } from '../db.js'
import { askSupport } from '../support.js'
import { listServices, stopService, restartService, removeService, watchService, serviceTail } from '../services.js'
import { fail, int, found, str, background, project } from '../http.js'

const app = express.Router()
export default app

// Support desk and its services

app.post('/api/projects/:id/support', (req, res) => {
  const p = project(req), { text, model } = req.body ?? {}
  if (model !== undefined && !['haiku', 'sonnet', 'opus'].includes(model)) throw fail(400, 'model must be haiku, sonnet or opus')
  background(p.id, askSupport(p.id, str(text, 'text'), { model }))
  res.status(202).json({ ok: true })
})

app.get('/api/projects/:id/services', (req, res) => res.json(listServices(project(req).id)))

const service = req => found(get('SELECT * FROM services WHERE id = ?', int(req.params.id)), 'service')

app.post('/api/services/:id/stop', (req, res) => res.json(stopService(service(req).id)))
app.post('/api/services/:id/restart', async (req, res) => res.json(await restartService(service(req).id)))
app.delete('/api/services/:id', (req, res) => {
  try { removeService(service(req).id) } catch (e) { throw fail(409, e.message) }
  res.json({ ok: true })
})

// Service output as SSE, same shape as a run's terminal.
app.get('/api/services/:id/log', (req, res) => {
  const s = service(req)
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`)
  const end = () => { res.write('event: end\ndata: {}\n\n'); res.end() }
  const stop = watchService(s.id, d => d === null ? end() : send(d))
  if (!stop) { send(serviceTail(s.id)); return end() }
  const beat = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { clearInterval(beat); stop() })
})
