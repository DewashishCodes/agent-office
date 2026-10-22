import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
const { rebaseOnto, pushTo, listBranches } = await import('../server/github.js')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file) }

test('hotfix: rebased onto a branch that moved, then pushed as a fast-forward', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hotfix-'))
  const origin = join(root, 'origin.git'), a = join(root, 'a'), b = join(root, 'b')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, a)
  commit(a, 'base.txt', 'base')
  git(a, 'push', '-q', 'origin', 'HEAD:main')
  git(a, 'push', '-q', 'origin', 'HEAD:release')

  // The crew's task branch starts at main, then someone else pushes to main.
  const base = git(a, 'rev-parse', 'HEAD')
  git(a, 'checkout', '-qb', 'crew/t1')
  commit(a, 'fix.txt', 'fix')
  git(root, 'clone', '-q', origin, b)
  commit(b, 'other.txt', 'other')
  git(b, 'push', '-q', 'origin', 'HEAD:main')

  const newBase = await rebaseOnto(a, base, 'crew/t1', 'main')
  assert.equal(newBase, git(b, 'rev-parse', 'HEAD'))
  await pushTo(a, 'crew/t1:refs/heads/main')
  const log = git(origin, 'log', '--format=%s', 'main').split('\n')
  assert.deepEqual(log, ['fix.txt', 'other.txt', 'base.txt'])
  // The task branch itself never reaches GitHub.
  assert.deepEqual(await listBranches({ local_path: a }), ['main', 'release'])
})
