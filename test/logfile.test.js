import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rotate } from '../server/logfile.js'

test('rotate: a log past the limit becomes .1, replacing the old one; a small one stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-log-')), log = join(dir, 'server.log')
  writeFileSync(log, 'small')
  rotate(log, 100)
  assert.equal(readFileSync(log, 'utf8'), 'small')
  writeFileSync(`${log}.1`, 'older')
  writeFileSync(log, 'x'.repeat(200))
  rotate(log, 100)
  assert.equal(existsSync(log), false)
  assert.equal(readFileSync(`${log}.1`, 'utf8').length, 200)
  rotate(join(dir, 'missing.log'), 100)
})
