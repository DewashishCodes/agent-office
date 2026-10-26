import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
process.env.OWNER_TOKEN = 'test-owner-token'
const { insert, DEFAULT_SETTINGS } = await import('../server/db.js')
const { app } = await import('../server/index.js')

test('settings: the Settings form saves every default key, unknown keys are refused', async t => {
  const server = app.listen(0)
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/api`
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-owner-token' }) })
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }
  const id = insert('projects', { name: 'p', repo: 'o/p' })
  const patch = settings => fetch(`${base}/projects/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ settings }) })

  const ok = await patch({ ...DEFAULT_SETTINGS, github_issues: false }), body = await ok.text()
  assert.equal(ok.status, 200, body)
  assert.equal(JSON.parse(body).settings.github_issues, false)
  assert.equal((await patch({ nope: 1 })).status, 400)
})
