import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
const { insert, getTask, getAgent } = await import('../server/db.js')
const { removeAgent, recover } = await import('../server/scheduler.js')

const project_id = insert('projects', { name: 'p', repo: 'o/p', paused: 1 })
const order_id = insert('orders', { project_id, text: 'x', status: 'in_progress' })
const task = (fields) => insert('tasks', { project_id, order_id, title: 't', role: 'backend', ...fields })

test('removeAgent: in-flight work goes back to planned without an attempt, blocked stays blocked', () => {
  const a = insert('agents', { project_id, name: 'Backend Dev', role: 'backend', owned_paths: ['api/**'] })
  const planned = task({ agent_id: a })
  const working = task({ agent_id: a, status: 'in_progress', attempts: 1, notes: 'Fix the test' })
  const review = task({ agent_id: a, status: 'in_review' })
  const blocked = task({ agent_id: a, status: 'blocked', attempts: 2 })
  removeAgent(a)
  assert.ok(getAgent(a).removed_at)
  for (const id of [planned, working, review]) {
    const t = getTask(id)
    assert.equal(t.status, 'planned')
    assert.equal(t.agent_id, null)
  }
  assert.equal(getTask(working).attempts, 1)
  assert.match(getTask(working).notes, /^Reassigned: Backend Dev was removed\.\n\nFix the test$/)
  assert.equal(getTask(planned).notes, '')
  assert.equal(getTask(blocked).status, 'blocked')
  assert.equal(getTask(blocked).agent_id, null)
})

test('recover: a restart never counts as a failed attempt', () => {
  const t1 = task({ status: 'in_progress', attempts: 1 })
  const t2 = task({ status: 'in_review' })
  insert('runs', { project_id, task_id: t1, kind: 'task' })
  recover()
  assert.equal(getTask(t1).status, 'planned')
  assert.equal(getTask(t1).attempts, 1)
  // No worktree yet: review cannot restart, so the task is built again.
  assert.equal(getTask(t2).status, 'planned')
  assert.equal(getTask(t2).attempts, 0)
})
