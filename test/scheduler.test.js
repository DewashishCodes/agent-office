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

test('file lock: a ready task waits for overlapping work of another order', async () => {
  const { kick } = await import('../server/scheduler.js')
  const pid = insert('projects', { name: 'q', repo: 'o/q' })
  const a = insert('agents', { project_id: pid, name: 'Web', role: 'frontend', owned_paths: ['web/**'], max_parallel: 5, status: 'paused' })
  const o1 = insert('orders', { project_id: pid, text: 'one', status: 'in_progress' })
  const o2 = insert('orders', { project_id: pid, text: 'two', status: 'in_progress' })
  const busy = insert('tasks', { project_id: pid, order_id: o1, title: 'a', role: 'frontend', files: ['web/src/**'], status: 'in_progress', agent_id: a })
  const waiting = insert('tasks', { project_id: pid, order_id: o2, title: 'b', role: 'frontend', files: ['web/src/App.jsx'] })
  kick()
  await new Promise(r => setTimeout(r, 400))
  assert.equal(getTask(waiting).wait_reason, `Waiting for #${busy} (same files)`)
  assert.equal(getTask(waiting).status, 'planned')
})

test('cancelTask: dependents block, failTask cannot revive it, last task cancels an empty order', async () => {
  const { cancelTask, failTask } = await import('../server/scheduler.js')
  const { getOrder } = await import('../server/db.js')
  const o = insert('orders', { project_id, text: 'drop', status: 'in_progress' })
  const a = insert('tasks', { project_id, order_id: o, title: 'a', role: 'backend' })
  const b = insert('tasks', { project_id, order_id: o, title: 'b', role: 'backend', depends_on: [a] })
  cancelTask(a)
  assert.equal(getTask(a).status, 'canceled')
  assert.equal(getTask(b).status, 'blocked')
  assert.match(getTask(b).notes, /canceled/)
  failTask(a, 'late crash')
  assert.equal(getTask(a).status, 'canceled')
  assert.throws(() => cancelTask(a), /already canceled/)
  assert.equal(getOrder(o).status, 'in_progress')
  cancelTask(b)
  assert.equal(getOrder(o).status, 'canceled')
})

test('markMerged removes the task worktree', async () => {
  const { execFileSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { markMerged } = await import('../server/scheduler.js')
  const repo = mkdtempSync(join(tmpdir(), 'crew-repo-')), wt = repo + '-wt'
  const git = (...a) => execFileSync('git', a, { cwd: repo })
  git('init', '-q'); git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x')
  git('worktree', 'add', '-q', '-b', 'crew/t1', wt)
  const pid = insert('projects', { name: 'w', repo: 'o/w', local_path: repo, paused: 1 })
  const o = insert('orders', { project_id: pid, text: 'w', status: 'in_progress' })
  const t = insert('tasks', { project_id: pid, order_id: o, title: 'w', role: 'backend', status: 'done', worktree: wt })
  assert.ok(existsSync(wt))
  markMerged(t)
  for (let i = 0; i < 50 && existsSync(wt); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(existsSync(wt), false)
})

test('poll: one PR list call per project, checks stored, merges marked', async () => {
  const { poll } = await import('../server/scheduler.js')
  const { run } = await import('../server/db.js')
  run('UPDATE tasks SET pr_number = NULL')
  const p1 = insert('projects', { name: 'a', repo: 'o/a', paused: 1 }), p2 = insert('projects', { name: 'b', repo: 'o/b', paused: 1 })
  const ids = [p1, p1, p1, p2].map((pid, i) => insert('tasks', { project_id: pid, order_id: insert('orders', { project_id: pid, text: 'x' }), title: 't', role: 'backend', status: 'done', pr_number: i + 1 }))
  const calls = [], single = []
  const list = async p => { calls.push(p.id); return new Map([[1, { state: 'OPEN', checks: 'fail' }], [2, { state: 'MERGED', checks: 'pass' }], [4, { state: 'OPEN', checks: 'pending' }]]) }
  const one = async (p, n) => { single.push(n); return { state: 'OPEN', checks: 'none' } }
  await poll({ list, one })
  assert.deepEqual(calls.sort(), [p1, p2].sort())
  assert.deepEqual(single, [3])
  assert.deepEqual(ids.map(id => getTask(id).checks), ['fail', 'pass', 'none', 'pending'])
  assert.equal(getTask(ids[1]).merged, 1)
})

test('recover: an interrupted task keeps its agent session to resume', async () => {
  const a = insert('agents', { project_id, name: 'Resumer', role: 'backend', owned_paths: ['api/**'] })
  const t = task({ status: 'in_progress', agent_id: a })
  insert('runs', { project_id, task_id: t, agent_id: a, kind: 'task', session_id: 'old-sess' })
  insert('runs', { project_id, task_id: t, agent_id: a, kind: 'task', session_id: 'sess-cut', status: 'running' })
  const other = task({ status: 'in_progress', agent_id: a })
  recover()
  assert.equal(getTask(t).resume_session, 'sess-cut')
  assert.equal(getTask(t).status, 'planned')
  assert.equal(getTask(other).resume_session, null)
})
