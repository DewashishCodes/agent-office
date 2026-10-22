import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.CREW_DB = ':memory:'
process.env.CREW_DATA_DIR = mkdtempSync(join(tmpdir(), 'crew-'))
const { parseProposal } = await import('../server/rules.js')
const { FLOORS, TEMPLATES, FLOOR_TEAMS } = await import('../server/roster.js')
const { inspectFolder, initRepo, parseRemote } = await import('../server/github.js')

const templates = [...TEMPLATES.map(t => ({ ...t, floor: 'tech' })), ...Object.values(FLOOR_TEAMS).flat()]
const block = v => `Here is the office.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``

test('parseProposal: templates, custom agents, required leads, dropped entries', () => {
  const { text, proposal } = parseProposal(block({
    brief: '## Product\nA todo app', floors: ['design', 'nope'],
    agents: [
      { template: 'frontend' }, { template: 'product-designer', name: 'Mia' }, { template: 'ghost' },
      { name: 'Mobile Dev', floor: 'tech', role: 'Mobile', owned_paths: ['mobile/**', '../etc'], model: 'gpt' },
      { name: 'No Paths', floor: 'tech' },
      { name: 'Writer', floor: 'docs', owned_paths: ['docs/**'] },
    ],
    first_order: 'Scaffold it',
  }), { floors: FLOORS, templates })
  assert.equal(text, 'Here is the office.')
  assert.deepEqual(proposal.floors, ['tech', 'design', 'docs'])
  const names = proposal.agents.map(a => a.name)
  for (const n of ['Orchestrator', 'Code Reviewer', 'QA', 'Design Lead', 'Design Reviewer', 'Docs Lead', 'Editor', 'Frontend Dev', 'Mia', 'Mobile Dev', 'Writer']) assert.ok(names.includes(n), n)
  assert.ok(!names.includes('No Paths'))
  assert.ok(proposal.agents.find(a => a.name === 'Design Lead').locked)
  assert.ok(!proposal.agents.find(a => a.name === 'Mia').locked)
  const mobile = proposal.agents.find(a => a.name === 'Mobile Dev')
  assert.deepEqual(mobile.owned_paths, ['mobile/**'])
  assert.equal(mobile.model, 'sonnet')
  assert.equal(mobile.role, 'mobile')
  assert.equal(proposal.first_order, 'Scaffold it')
  assert.equal(proposal.notes.length, 2)
  assert.equal(parseProposal('just a question?', { floors: FLOORS, templates }).proposal, null)
})

test('parseProposal: duplicate names get a number', () => {
  const { proposal } = parseProposal(block({ agents: [{ template: 'frontend' }, { template: 'frontend' }] }), { floors: FLOORS, templates })
  assert.deepEqual(proposal.agents.filter(a => a.role === 'frontend').map(a => a.name), ['Frontend Dev', 'Frontend Dev 2'])
})

test('parseRemote: GitHub https and ssh, others null', () => {
  assert.equal(parseRemote('https://github.com/a/b.git'), 'a/b')
  assert.equal(parseRemote('git@github.com:a-b/c.d.git'), 'a-b/c.d')
  assert.equal(parseRemote('https://gitlab.com/a/b'), null)
})

test('inspectFolder and initRepo: secrets stay out of the first commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-'))
  writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(dir, '.env'), 'SECRET=1\n')
  writeFileSync(join(dir, '.env.example'), 'SECRET=\n')
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '')
  const before = await inspectFolder(dir)
  assert.equal(before.git, false)
  assert.equal(before.files, 3)
  assert.deepEqual(before.secrets, ['.env'])

  await initRepo(dir, { 'docs/PRD.md': 'idea\n' })
  const after = await inspectFolder(dir)
  assert.equal(after.git, true)
  assert.equal(after.commits, true)
  assert.equal(after.repo, null)
  assert.deepEqual(after.secrets, [])
  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  assert.deepEqual(tracked, ['.env.example', '.gitignore', 'app.js', 'docs/PRD.md'])
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /node_modules\//)
})
