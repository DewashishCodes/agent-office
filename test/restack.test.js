import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
const { restack } = await import('../server/github.js')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const id = ['-c', 'user.name=t', '-c', 'user.email=t@t']
const commit = (cwd, text) => { writeFileSync(join(cwd, 'f.txt'), text); git(cwd, 'add', '.'); git(cwd, ...id, 'commit', '-qm', text) }

test('restack: a stacked branch squash merges cleanly after its dependency was squash merged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'restack-'))
  const origin = join(root, 'origin.git'), a = join(root, 'a')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, a)
  commit(a, 'base')
  git(a, 'push', '-q', 'origin', 'HEAD:main')

  // t1 changes the line, t2 merges t1 (like runTask does for deps) and changes it again.
  git(a, 'checkout', '-qb', 'crew/t1')
  commit(a, 'one')
  git(a, 'checkout', '-q', '-b', 'crew/t2', 'main')
  git(a, ...id, 'merge', '-q', '--no-edit', 'crew/t1')
  const base = git(a, 'rev-parse', 'HEAD')
  commit(a, 'two')
  git(a, 'push', '-q', 'origin', 'crew/t2')

  // GitHub squash merges t1: main gets a new commit with t1's change.
  git(a, 'checkout', '-q', 'main')
  git(a, 'merge', '-q', '--squash', 'crew/t1')
  git(a, ...id, 'commit', '-qm', 'one (#1)')
  git(a, 'push', '-q', 'origin', 'main')

  // Without the restack, squashing t2 conflicts: both sides changed the line from "base".
  assert.throws(() => execFileSync('git', ['merge', '--squash', 'crew/t2'], { cwd: a, stdio: 'ignore' }))
  git(a, 'reset', '-q', '--hard')

  git(a, 'checkout', '-q', 'crew/t2')
  const newBase = await restack(a, base, 'crew/t2', 'main')
  assert.equal(newBase, git(a, 'rev-parse', 'origin/main'))
  assert.equal(git(origin, 'rev-parse', 'crew/t2'), git(a, 'rev-parse', 'crew/t2'))
  git(a, 'checkout', '-q', 'main')
  git(a, 'merge', '-q', '--squash', 'crew/t2')
  git(a, ...id, 'commit', '-qm', 'two (#2)')
  assert.equal(git(a, 'show', 'HEAD:f.txt'), 'two')
})
