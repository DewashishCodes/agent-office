import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
const { reapFolder } = await import('../server/runner.js')

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

test('reapFolder: a process left running from a worktree is ended, others are not', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crew-')), 'worktrees', 'crew-t1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server.js'), 'setInterval(() => {}, 1000)\n')
  const left = spawn(process.execPath, [join(dir, 'server.js')], { detached: true, stdio: 'ignore' })
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 500))
  reapFolder(dir)
  for (let i = 0; i < 40 && alive(left.pid); i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(alive(left.pid), false)
  assert.equal(alive(other.pid), true)
  process.kill(other.pid)
})
