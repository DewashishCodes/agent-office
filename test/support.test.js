import { test } from 'node:test'
import assert from 'node:assert/strict'
import { supportPolicy, readOnlySql, permissionPolicy } from '../server/rules.js'

process.env.CREW_DB = ':memory:'
const { DEFAULT_SETTINGS } = await import('../server/db.js')

const cwd = 'C:/repo'
const bash = command => supportPolicy(DEFAULT_SETTINGS, 'Bash', { command }, cwd)

test('support: looking around runs without asking', () => {
  for (const c of ['git status', 'git log --oneline -5', 'git branch -a', 'ls -la', 'cat package.json | head -20', 'npm test', 'npm run lint',
    'curl -s http://localhost:5173/health', 'tail -n 50 logs/app.log 2>&1', 'grep -rn TODO src > /dev/null']) {
    assert.equal(bash(c), 'allow', c)
  }
})

test('support: anything that changes state asks', () => {
  for (const c of ['npm install', 'npm run dev', 'git commit -m x', 'git branch -D old', 'git tag v1', 'git remote add x y', 'rm -rf dist',
    'node -e "require(\'fs\').rmSync(\'x\')"', 'echo hi > notes.txt', 'cat a >> b', 'find . -name "*.log" -delete', 'kill 1234',
    'curl -X POST https://example.com', 'env', 'printenv', 'ls $(cat x)', 'git status && npm install']) {
    assert.equal(bash(c), 'ask', c)
  }
})

test('support: read-only SQL runs, writes and scripts ask', () => {
  assert.equal(bash('sqlite3 data/app.db "SELECT COUNT(*) FROM users"'), 'allow')
  assert.equal(bash(`sqlite3 data/app.db "select id, email from users where created_at > date('now', '-1 day')"`), 'allow')
  assert.equal(bash('psql -d app -c "SELECT * FROM orders LIMIT 5"'), 'allow')
  assert.equal(bash('sqlite3 data/app.db ".tables"'), 'allow')
  assert.equal(bash('sqlite3 data/app.db "UPDATE users SET admin = 1"'), 'ask')
  assert.equal(bash('sqlite3 data/app.db "SELECT 1; DELETE FROM users"'), 'ask')
  assert.equal(bash('psql -c "drop table users"'), 'ask')
  assert.equal(bash('sqlite3 data/app.db "PRAGMA journal_mode = DELETE"'), 'ask')
  assert.equal(bash('sqlite3 data/app.db ".read wipe.sql"'), 'ask')
  assert.equal(bash('sqlite3 data/app.db'), 'ask')
  assert.equal(bash('psql -f migrate.sql'), 'ask')
  assert.equal(readOnlySql('mysql -e "WITH x AS (SELECT 1) SELECT * FROM x"'), true)
  assert.equal(readOnlySql('ls "a b"'), false)
})

test('support: never edits files, reads inside the repo, asks outside', () => {
  assert.equal(supportPolicy(DEFAULT_SETTINGS, 'Edit', { file_path: 'C:/repo/a.js' }, cwd), 'deny')
  assert.equal(supportPolicy(DEFAULT_SETTINGS, 'Write', { file_path: 'C:/repo/a.js' }, cwd), 'deny')
  assert.equal(supportPolicy(DEFAULT_SETTINGS, 'Read', { file_path: 'C:/repo/src/a.js' }, cwd), 'allow')
  assert.equal(supportPolicy(DEFAULT_SETTINGS, 'Read', { file_path: 'C:/repo/.env' }, cwd), 'deny')
  assert.equal(supportPolicy(DEFAULT_SETTINGS, 'Read', { file_path: 'C:/other/secret.txt' }, cwd), 'ask')
  assert.equal(supportPolicy(DEFAULT_SETTINGS, 'mcp__crew__service_start', {}, cwd), 'allow')
  assert.equal(supportPolicy(DEFAULT_SETTINGS, 'WebFetch', { url: 'https://x' }, cwd), 'ask')
})

test('task policy unchanged by the shared Bash parser', () => {
  const p = c => permissionPolicy(DEFAULT_SETTINGS, {}, 'Bash', { command: c }, cwd)
  assert.equal(p('npm test && git add -A && git commit -m "fix: a; b"'), 'allow')
  assert.equal(p('echo x > notes.txt'), 'allow')
  assert.equal(p('echo x > /etc/passwd'), 'ask')
  assert.equal(p('rm -rf /'), 'ask')
})
