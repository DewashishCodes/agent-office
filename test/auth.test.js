import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
process.env.OWNER_TOKEN = 'test-owner-token'
const { app } = await import('../server/index.js')

const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api`
const login = async () => {
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-owner-token' }) })
  assert.equal(res.status, 200)
  return res.headers.get('set-cookie').split(';')[0]
}
const me = cookie => fetch(`${base}/me`, { headers: { cookie } }).then(r => r.status)
const logout = (cookie, body = {}) => fetch(`${base}/logout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('sessions: a cookie copied before logout gets 401 after it', async t => {
  t.after(() => { server.closeAllConnections(); server.close() })
  const a = await login(), b = await login()
  assert.notEqual(a, b)
  assert.equal(await me(a), 200)
  assert.equal(await me('crew=forged'), 401)

  await logout(a)
  assert.equal(await me(a), 401)
  assert.equal(await me(b), 200, 'other devices stay logged in')

  const c = await login()
  await logout(c, { all: true })
  assert.equal(await me(b), 401)
  assert.equal(await me(c), 401)
})
