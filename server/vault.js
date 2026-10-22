import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { all, get, insert, update, run, getAgent, now, DATA_DIR } from './db.js'
import { emit } from './bus.js'

// Shared context vault: owner notes, decisions agents record, uploaded files, plus the repo's own crew docs (read live from the clone).
// Agents get only the titles in their prompt and pull what they need with vault_search / vault_read.

export const REPO_DOCS = ['CLAUDE.md', '.crew/BRIEF.md', '.crew/PLAYBOOK.md', '.crew/owned-paths.json']
const TEXT_EXT = /^\.(md|txt|json|ya?ml|csv|tsv|js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|rb|php|css|scss|html|xml|sql|sh|toml|ini|env\.example|log)$/i
const MAX_TEXT = 512 * 1024

export const vaultDir = project_id => join(DATA_DIR, 'vault', String(project_id))
export const filePath = row => join(vaultDir(row.project_id), row.file)

const LIST = 'id, project_id, kind, title, file, mime, size, tags, author_agent_id, created_at, updated_at, substr(body, 1, 240) AS snippet'
export const listVault = project_id => all(`SELECT ${LIST} FROM vault WHERE project_id = ? ORDER BY updated_at DESC, id DESC`, project_id)
export const getEntry = id => get('SELECT * FROM vault WHERE id = ?', id)

const changed = (project_id, row) => { emit('vault', project_id, row); return row }

export function addEntry(project_id, { kind, title, body = '', tags = [], author_agent_id = null }) {
  const id = insert('vault', { project_id, kind, title: title.trim().slice(0, 200), body, tags, author_agent_id })
  return changed(project_id, getEntry(id))
}

export function updateEntry(id, fields) {
  const row = getEntry(id)
  update('vault', id, { ...fields, updated_at: now() })
  return changed(row.project_id, getEntry(id))
}

export function deleteEntry(id) {
  const row = getEntry(id)
  if (row.file) rmSync(filePath(row), { force: true })
  run('DELETE FROM vault WHERE id = ?', id)
  changed(row.project_id, { id, deleted: true })
}

// Text files keep their text in body so agents can read them through vault_read; other files are read with the Read tool by path.
export function addFile(project_id, name, mime, buf, author_agent_id = null) {
  const safe = name.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file'
  const text = (TEXT_EXT.test(extname(safe)) || /^text\/|json|xml|yaml/.test(mime || '')) && buf.length <= MAX_TEXT
  const id = insert('vault', { project_id, kind: 'file', title: safe, body: text ? buf.toString('utf8') : '', mime: mime || null, size: buf.length, author_agent_id })
  const file = `${id}-${safe}`
  mkdirSync(vaultDir(project_id), { recursive: true })
  writeFileSync(join(vaultDir(project_id), file), buf)
  update('vault', id, { file })
  return changed(project_id, getEntry(id))
}

export function repoDocs(project) {
  if (!project.local_path) return []
  return REPO_DOCS.map(path => {
    const full = join(project.local_path, path)
    return existsSync(full) ? { path, size: statSync(full).size } : null
  }).filter(Boolean)
}

export async function readDoc(project, path) {
  if (!REPO_DOCS.includes(path) || !project.local_path) return null
  return readFile(join(project.local_path, path), 'utf8').catch(() => null)
}

const who = id => (id ? getAgent(id)?.name : null) || 'the owner'

// Titles for a prompt, newest first; the full text is one vault_read away.
export function vaultIndex(project_id, max = 40) {
  const rows = listVault(project_id).slice(0, max)
  return rows.map(r => `- #${r.id} [${r.kind}] ${r.title}${r.tags.length ? ` (${r.tags.join(', ')})` : ''}`).join('\n')
}

// Plain term scoring: title counts most, then tags, then body. Good enough for a few hundred entries.
export function searchVault(project_id, query) {
  const terms = String(query || '').toLowerCase().split(/\W+/).filter(t => t.length > 1)
  const rows = all('SELECT * FROM vault WHERE project_id = ?', project_id)
  if (!terms.length) return rows.slice(-20).reverse()
  const count = (s, t) => s.split(t).length - 1
  return rows.map(r => {
    const title = r.title.toLowerCase(), tags = r.tags.join(' ').toLowerCase(), body = r.body.toLowerCase()
    const score = terms.reduce((n, t) => n + count(title, t) * 5 + count(tags, t) * 3 + Math.min(count(body, t), 10), 0)
    return { r, score }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 15).map(x => x.r)
}

export function describeHits(rows) {
  if (!rows.length) return 'Nothing in the vault matches. Try other words, or decide yourself and record it with vault_write.'
  return rows.map(r => `#${r.id} [${r.kind}] ${r.title}${r.tags.length ? ` (${r.tags.join(', ')})` : ''}, by ${who(r.author_agent_id)}, ${r.updated_at}\n  ${(r.body || (r.file ? `file ${r.mime || ''} ${r.size} bytes` : '')).replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
}

export function readForAgent(project_id, id) {
  const r = getEntry(Number(id))
  if (!r || r.project_id !== project_id) return `No vault entry #${id}.`
  const head = `#${r.id} [${r.kind}] ${r.title}, by ${who(r.author_agent_id)}, updated ${r.updated_at}${r.tags.length ? `, tags: ${r.tags.join(', ')}` : ''}`
  if (r.kind === 'file' && !r.body) return `${head}\nBinary file (${r.mime || 'unknown type'}, ${r.size} bytes). Read it with the Read tool at:\n${filePath(r)}`
  return `${head}\n\n${r.body.slice(0, 100000)}${r.body.length > 100000 ? '\n... cut at 100k characters' : ''}`
}
