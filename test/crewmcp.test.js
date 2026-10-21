import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
process.env.CREW_CLAUDE_BIN = join(import.meta.dirname, 'fake-claude.mjs')
const { insert, all } = await import('../server/db.js')
const { runClaude, killRun } = await import('../server/runner.js')
const { mcpHandler, CREW_TOOLS, takeQueued } = await import('../server/crewmcp.js')

const app = express()
app.use(express.json())
app.all('/mcp/:token', mcpHandler)
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = server.address().port

const project_id = insert('projects', { name: 'p', repo: 'o/p' })
const alice = insert('agents', { project_id, name: 'Alice', role: 'backend' })
const bob = insert('agents', { project_id, name: 'Bob', role: 'frontend' })

// The fake CLI answers "MCP" with the --mcp-config it was given, which carries the run token.
const first = runClaude({ project_id, agent_id: alice, kind: 'task', cwd: process.env.CREW_DATA_DIR, prompt: 'MCP', mcp: CREW_TOOLS, keepOpen: true })
const run_id = all('SELECT MAX(id) AS id FROM runs')[0].id
let token
for (let i = 0; i < 100 && !token; i++) {
  await new Promise(r => setTimeout(r, 20))
  const row = all(`SELECT json FROM run_events WHERE run_id = ? AND type = 'result'`, run_id)[0]
  if (row) token = JSON.parse(JSON.parse(row.json).result).mcpServers.crew.url.split('/').pop()
}
after(() => { killRun(run_id); server.close() })

const call = (body, t = token, method = 'POST') => fetch(`http://127.0.0.1:${port}/mcp/${t}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined,
})

test('handshake and tools/list', async () => {
  const init = await (await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json()
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
  assert.deepEqual(list.result.tools.map(t => t.name), CREW_TOOLS)
  assert.equal((await call(null, token, 'GET')).status, 405)
})

test('crew_post to an idle agent queues the message for its next task', async () => {
  const r = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crew_post', arguments: { to: 'bob', text: 'GET /api/users returns {id, name}' } } })).json()
  assert.match(r.result.content[0].text, /Bob is not working right now/)
  const row = all('SELECT * FROM crew_messages')[0]
  assert.equal(row.from_agent_id, alice)
  assert.equal(row.to_agent_id, bob)
  assert.equal(row.delivered, 0)
  assert.match(takeQueued(bob), /Alice: GET \/api\/users/)
  assert.equal(all('SELECT delivered FROM crew_messages')[0].delivered, 1)
})

test('unknown recipient is a tool error, unknown token is 401', async () => {
  const r = await (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'crew_post', arguments: { to: 'Zed', text: 'hi' } } })).json()
  assert.equal(r.result.isError, true)
  assert.equal((await call({ jsonrpc: '2.0', id: 5, method: 'ping' }, 'nope')).status, 401)
})

test('crew_task_status lists nothing without a task', async () => {
  const r = await (await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'crew_task_status', arguments: {} } })).json()
  assert.equal(r.result.content[0].text, 'No tasks found.')
  void first
})
