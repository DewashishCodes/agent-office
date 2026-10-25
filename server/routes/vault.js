// Vault: notes, decisions, files and repo docs. Mounted by server/index.js behind the owner cookie check.
import express from 'express'
import { listVault, getEntry, addEntry, updateEntry, deleteEntry, addFile, filePath, repoDocs, readDoc } from '../vault.js'
import { fail, int, found, isStrs, str, project } from '../http.js'

const app = express.Router()
export default app

// Vault

const entry = req => found(getEntry(int(req.params.id)), 'vault entry')
const tagsOf = v => (isStrs(v) ? v.map(t => t.trim()).filter(Boolean).slice(0, 12) : [])

app.get('/api/projects/:id/vault', (req, res) => {
  const p = project(req)
  res.json({ docs: repoDocs(p), items: listVault(p.id) })
})

app.get('/api/projects/:id/vault/doc', async (req, res) => {
  const text = await readDoc(project(req), String(req.query.path || ''))
  if (text == null) throw fail(404, 'document not found')
  res.json({ path: req.query.path, text })
})

app.post('/api/projects/:id/vault', (req, res) => {
  const p = project(req), { kind = 'note', title, body = '', tags } = req.body ?? {}
  if (!['note', 'decision'].includes(kind)) throw fail(400, 'kind must be note or decision')
  if (typeof body !== 'string') throw fail(400, 'body must be text')
  res.json(addEntry(p.id, { kind, title: str(title, 'title'), body, tags: tagsOf(tags) }))
})

// Raw body upload sent as application/octet-stream (a JSON file would otherwise hit the JSON parser); name and type in the query.
app.post('/api/projects/:id/vault/files', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const p = project(req)
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'empty file, or not sent as application/octet-stream')
  const type = typeof req.query.type === 'string' ? req.query.type.slice(0, 100) : null
  res.json(addFile(p.id, str(req.query.name, 'name'), type, req.body))
})

app.get('/api/vault/:id', (req, res) => res.json(entry(req)))

app.get('/api/vault/:id/file', (req, res) => {
  const e = entry(req)
  if (!e.file) throw fail(404, 'no file')
  res.download(filePath(e), e.title)
})

app.patch('/api/vault/:id', (req, res) => {
  const e = entry(req), { title, body, tags } = req.body ?? {}
  const fields = {}
  if (title !== undefined) fields.title = str(title, 'title').trim().slice(0, 200)
  if (body !== undefined) { if (typeof body !== 'string' || e.kind === 'file') throw fail(400, 'body must be text, files keep theirs'); fields.body = body }
  if (tags !== undefined) fields.tags = tagsOf(tags)
  res.json(updateEntry(e.id, fields))
})

app.delete('/api/vault/:id', (req, res) => {
  deleteEntry(entry(req).id)
  res.json({ ok: true })
})
