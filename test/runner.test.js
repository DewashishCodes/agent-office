import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
process.env.CREW_CLAUDE_BIN = join(import.meta.dirname, 'fake-claude.mjs')
const { insert, get, all } = await import('../server/db.js')
const { runClaude, sendToRun, interruptRun, resumeRun, answerPermission, getRunEvents } = await import('../server/runner.js')

const project_id = insert('projects', { name: 'p', repo: 'o/p' })
const base = { project_id, kind: 'task', cwd: process.env.CREW_DATA_DIR }
const until = async f => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(f(), 'timed out') }
const row = id => get('SELECT * FROM runs WHERE id = ?', id)

test('runClaude: transcript stored, result resolves the run', async () => {
  const r = await runClaude({ ...base, prompt: 'hello' })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'got: hello')
  assert.deepEqual(getRunEvents(r.run_id).map(e => e.type), ['prompt', 'assistant', 'result'])
  assert.equal(row(r.run_id).status, 'ok')
  assert.equal(row(r.run_id).turn, 1)
})

test('permission ask: inbox item, owner allows, run finishes', async () => {
  const p = runClaude({ ...base, prompt: 'ASK please', permissionPolicy: () => 'ask' })
  let run_id
  await until(() => (run_id = get(`SELECT run_id FROM inbox WHERE kind = 'permission' AND status = 'open'`)?.run_id))
  assert.equal(row(run_id).pending_permission[0].tool_name, 'Bash')
  answerPermission(run_id, 'perm-1', true)
  const r = await p
  assert.equal(r.text, 'allowed curl example.com')
  assert.equal(row(run_id).pending_permission, null)
  assert.equal(all(`SELECT * FROM inbox WHERE run_id = ? AND status = 'open'`, run_id).length, 0)
})

test('policy deny answers without asking', async () => {
  const r = await runClaude({ ...base, prompt: 'ASK', permissionPolicy: () => 'deny' })
  assert.match(r.text, /^denied:/)
})

test('keepOpen run: send, interrupt, resume', async () => {
  const p = runClaude({ ...base, prompt: 'first', keepOpen: true })
  const id = get('SELECT MAX(id) AS id FROM runs').id
  await until(() => row(id).state === 'waiting')
  sendToRun(id, 'second')
  await until(() => getRunEvents(id).some(e => e.type === 'result' && JSON.parse(e.json).result === 'got: second'))
  assert.equal(getRunEvents(id).find(e => e.type === 'owner').json, JSON.stringify({ text: 'second' }))
  await interruptRun(id)
  assert.equal(row(id).state, 'paused')
  resumeRun(id, 'go on')
  const r = await p
  assert.equal(r.ok, true)
  assert.equal(r.text, 'got: go on')
  assert.equal(row(id).turn, 4)
})
