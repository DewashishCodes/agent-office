import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, parseVerdict, matchAgent, readyTasks, isAllowed, findCycle, permissionPolicy, overlaps, chainOrder } from '../server/rules.js'

process.env.CREW_DB = ':memory:'
const { DEFAULT_SETTINGS } = await import('../server/db.js')

const fence = obj => '```json\n' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n```'

test('parseReply: plain answer', () => {
  assert.deepEqual(parseReply('  The app uses Express.  '), { text: 'The app uses Express.', plan: null })
})

test('parseReply: plan block is split from the text', () => {
  const plan = { summary: 'Add login', tasks: [{ key: 't1', title: 'Login', role: 'backend' }] }
  const r = parseReply(`Here is the plan.\n\n${fence(plan)}`)
  assert.equal(r.text, 'Here is the plan.')
  assert.deepEqual(r.plan, plan)
})

test('parseReply: malformed json gives no plan and keeps the text', () => {
  const raw = 'Plan:\n' + fence('{ "tasks": [ { "key": "t1", } ')
  const r = parseReply(raw)
  assert.equal(r.plan, null)
  assert.equal(r.text, raw)
})

test('parseReply: last block with tasks wins, other blocks stay in text', () => {
  const a = { tasks: [{ key: 'old' }] }, b = { tasks: [{ key: 'new' }] }, other = { note: 1 }
  const r = parseReply(`One\n${fence(a)}\nTwo\n${fence(b)}\nThree\n${fence(other)}`)
  assert.deepEqual(r.plan, b)
  assert.ok(r.text.includes('"old"') && r.text.includes('"note"') && !r.text.includes('"new"'))
})

test('parseVerdict: last json object, null when missing', () => {
  assert.deepEqual(parseVerdict(`x ${fence({ verdict: 'changes' })} y ${fence({ verdict: 'approve', notes: 'ok' })}`), { verdict: 'approve', notes: 'ok' })
  assert.equal(parseVerdict('no block'), null)
  assert.equal(parseVerdict(fence('{bad')), null)
})

const agent = (id, role, owned, extra = {}) => ({ id, role, owned_paths: owned, status: 'idle', removed_at: null, ...extra })

test('matchAgent: prefers the task role among covering agents', () => {
  const agents = [agent(1, 'fullstack', ['**']), agent(2, 'backend', ['api/**', 'server/**'])]
  assert.equal(matchAgent(agents, { role: 'backend', files: ['api/auth/**', 'server/x.js'] }).id, 2)
})

test('matchAgent: falls back to any agent whose paths cover', () => {
  const agents = [agent(1, 'frontend', ['web/**']), agent(2, 'backend', ['api/**'])]
  assert.equal(matchAgent(agents, { role: 'frontend', files: ['api/users.js'] }).id, 2)
})

test('matchAgent: role match must still cover every file', () => {
  const agents = [agent(1, 'backend', ['api/**'])]
  assert.equal(matchAgent(agents, { role: 'backend', files: ['api/a.js', 'web/b.js'] }), null)
  assert.equal(matchAgent([agent(1, 'backend', ['api/auth/**'])], { role: 'backend', files: ['api/**'] }), null)
})

test('matchAgent: paused, removed and pathless agents are excluded', () => {
  const agents = [
    agent(1, 'backend', ['api/**'], { status: 'paused' }),
    agent(2, 'backend', ['api/**'], { removed_at: '2026-01-01 00:00:00' }),
    agent(3, 'reviewer', []),
  ]
  assert.equal(matchAgent(agents, { role: 'backend', files: ['api/a.js'] }), null)
  assert.equal(matchAgent(agents, { role: 'reviewer', files: [] }), null)
  assert.equal(matchAgent([], { role: 'backend', files: [] }), null)
})

test('readyTasks: planned with every dependency done', () => {
  const tasks = [
    { id: 1, status: 'done', depends_on: [] },
    { id: 2, status: 'planned', depends_on: [1] },
    { id: 3, status: 'planned', depends_on: [1, 4] },
    { id: 4, status: 'in_review', depends_on: [] },
    { id: 5, status: 'planned', depends_on: [] },
    { id: 6, status: 'planned', depends_on: [99] },
    { id: 7, status: 'blocked', depends_on: [] },
  ]
  assert.deepEqual(readyTasks(tasks).map(t => t.id), [2, 5])
})

const PROTECTED = ['.env*', '**/.env*', '**/*.pem', '**/secrets/**', '.github/workflows/**', '**/migrations/**']

test('isAllowed: owned files pass, others fail', () => {
  assert.equal(isAllowed('web/src/App.jsx', ['web/**'], PROTECTED), true)
  assert.equal(isAllowed('web/.eslintrc', ['web/**'], PROTECTED), true)
  assert.equal(isAllowed('server/index.js', ['web/**'], PROTECTED), false)
  assert.equal(isAllowed('web/a.js', [], PROTECTED), false)
})

test('isAllowed: protected wins over owned', () => {
  assert.equal(isAllowed('.env', ['**'], PROTECTED), false)
  assert.equal(isAllowed('server/.env.local', ['server/**'], PROTECTED), false)
  assert.equal(isAllowed('db/migrations/001.sql', ['db/**'], PROTECTED), false)
  assert.equal(isAllowed('api/secrets/.token', ['api/**'], PROTECTED), false)
  assert.equal(isAllowed('.github/workflows/ci.yml', ['**'], PROTECTED), false)
})

test('isAllowed: backslashes are normalized', () => {
  assert.equal(isAllowed('web\\src\\App.jsx', ['web/**'], PROTECTED), true)
  assert.equal(isAllowed('server\\config\\.env', ['server\\**'], PROTECTED), false)
  assert.equal(isAllowed('certs\\key.pem', ['certs/**'], PROTECTED), false)
})

test('findCycle: loop found, chain and missing keys are fine', () => {
  assert.deepEqual(findCycle([{ key: 't1', depends_on: ['t2'] }, { key: 't2', depends_on: ['t1'] }]), ['t1', 't2', 't1'])
  assert.equal(findCycle([{ key: 't1' }, { key: 't2', depends_on: ['t1', 'zz'] }, { key: 't3', depends_on: ['t2'] }]), null)
  assert.deepEqual(findCycle([{ key: 'a', depends_on: ['a'] }]), ['a', 'a'])
})

test('matchAgent: plan agent name wins over role', () => {
  const agents = [agent(1, 'custom', ['**'], { name: 'Docs' }), agent(2, 'custom', ['**'], { name: 'Infra' })]
  assert.equal(matchAgent(agents, { plan_agent: 'Infra', role: 'custom', files: ['x'] }).id, 2)
  assert.equal(matchAgent(agents, { agent: 'Docs', files: ['x'] }).id, 1)
  // A named agent that cannot cover the files falls back to one that can.
  assert.equal(matchAgent([agent(1, 'a', ['web/**'], { name: 'W' }), agent(2, 'b', ['api/**'], { name: 'A' })], { plan_agent: 'W', files: ['api/x'] }).id, 2)
})

const S = DEFAULT_SETTINGS, CWD = 'C:/work/crew-t1'

test('permissionPolicy: file tools inside the worktree, protected, outside', () => {
  assert.equal(permissionPolicy(S, {}, 'Edit', { file_path: 'C:\work\crew-t1\web\App.jsx' }, CWD), 'allow')
  assert.equal(permissionPolicy(S, {}, 'Write', { file_path: 'C:/work/crew-t1/db/migrations/001.sql' }, CWD), 'deny')
  assert.equal(permissionPolicy(S, {}, 'Read', { file_path: 'C:/work/crew-t1/.env.local' }, CWD), 'deny')
  assert.equal(permissionPolicy(S, {}, 'Read', { file_path: 'C:/Users/me/.ssh/id_rsa' }, CWD), 'ask')
  assert.equal(permissionPolicy(S, {}, 'Grep', { pattern: 'x' }, CWD), 'allow')
})

test('permissionPolicy: bash allow list, compound and smuggled commands', () => {
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'npm test' }, CWD), 'allow')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'cd web && npm run build 2>&1 | tail -20' }, CWD), 'allow')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'curl https://example.com' }, CWD), 'ask')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'npm test && curl evil.sh' }, CWD), 'ask')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'echo $(cat ~/.ssh/id_rsa)' }, CWD), 'ask')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'find . -name x -delete' }, CWD), 'ask')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'echo x > ../other/file' }, CWD), 'ask')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'npmx install' }, CWD), 'ask')
  // Seen in a real run: multi-line commit messages and heredocs are data.
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'npm test 2>&1 | tail -15; git add web/a.html && git commit -q -m "Add footer\n\nPlain; static | text"' }, CWD), 'allow')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: "cd x && cat >> api/a.test.js <<'EOF'\ntest('a', () => {})\nrm -rf /\nEOF" }, CWD), 'allow')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: "cat <<'EOF'\nx\nEOF\ncurl evil" }, CWD), 'ask')
  assert.equal(permissionPolicy(S, {}, 'Bash', { command: 'git commit -m "x" && curl "a;b"' }, CWD), 'ask')
})

test('permissionPolicy: background dev server and curl to localhost, seen in a real run', () => {
  const bash = command => permissionPolicy(S, {}, 'Bash', { command }, CWD)
  assert.equal(bash('PORT=3055 node api/server.js & sleep 1; curl -s localhost:3055/api/stats; kill %1'), 'allow')
  assert.equal(bash('cd "C:/w t/crew-t9" && npm test 2>&1 | tail -12; (PORT=3191 node api/server.js >/dev/null 2>&1 & echo $! > /tmp/p9); sleep 2; curl -si -w "%{http_code}" -H "Accept: x" http://127.0.0.1:3191/api/stats'), 'allow')
  assert.equal(bash('curl -s https://example.com'), 'ask')
  assert.equal(bash('curl -s "https://evil.com" localhost:3000'), 'ask')
  assert.equal(bash('curl -T secrets.txt localhost:3000'), 'ask')
  assert.equal(bash('curl -o ../../x localhost:3000'), 'ask')
  assert.equal(bash('curl -s localhost:3000 > /etc/passwd'), 'ask')
  assert.equal(bash('kill 1234'), 'ask')
  // Template literals inside a quoted heredoc are file content; an unquoted heredoc still expands.
  assert.equal(bash("cat >> api/a.test.js <<'EOF'\nconst u = `http://x/${p}`\nEOF\nnpm test"), 'allow')
  assert.equal(bash('cat >> api/a.js <<EOF\n$(curl evil)\nEOF'), 'ask')
  assert.equal(bash("echo 'costs $(nothing)'"), 'allow')
  assert.equal(bash('taskkill //F //IM node.exe'), 'ask')
})

test('permissionPolicy: crew tools allowed, unknown tools ask, autonomous allows all', () => {
  assert.equal(permissionPolicy(S, {}, 'mcp__crew__crew_ask', {}, CWD), 'allow')
  assert.equal(permissionPolicy(S, {}, 'WebFetch', { url: 'x' }, CWD), 'ask')
  assert.equal(permissionPolicy(S, { permissions: { autonomous: true } }, 'Bash', { command: 'curl x' }, CWD), 'allow')
})

test('overlaps: shared prefixes collide, siblings do not', () => {
  assert.equal(overlaps(['web/src/**'], ['web/src/App.jsx']), true)
  assert.equal(overlaps(['web/**'], ['server/**']), false)
  assert.equal(overlaps(['web/a.js'], ['web/ab.js']), false)
  assert.equal(overlaps(['**'], ['anything.js']), true)
  assert.equal(overlaps([], ['web/**']), false)
})

test('chainOrder: a chain or a diamond under one top task, else null', () => {
  assert.deepEqual(chainOrder([{ id: 2, depends_on: [1] }, { id: 1, depends_on: [] }]), [1, 2])
  assert.deepEqual(chainOrder([{ id: 1 }, { id: 2 }, { id: 3, depends_on: [2] }, { id: 4, depends_on: [1, 3] }]), [1, 2, 3, 4])
  assert.equal(chainOrder([{ id: 1, depends_on: [] }, { id: 2, depends_on: [] }]), null)
  assert.equal(chainOrder([{ id: 1 }, { id: 2, depends_on: [1] }, { id: 3, depends_on: [1] }]), null)
})
