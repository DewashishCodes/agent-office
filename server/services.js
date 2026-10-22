import { mkdirSync, createWriteStream, existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import pty from '@lydell/node-pty'
import { all, get, insert, update, run, getProject, now, DATA_DIR } from './db.js'
import { emit } from './bus.js'
import { childEnv, killChild } from './runner.js'

// Long-running processes Support starts for the owner (dev servers, watchers). They belong to the crew server, not to an
// agent session, so they keep running after Support's turn ends. Each runs in a pty so its log reads like a terminal.

const LOG_DIR = join(DATA_DIR, 'services')
const RING = 256 * 1024
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g
const URL_RE = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?[^\s'"<>)]*/
// One plain command that serves or watches: no shell operators, so nothing else can ride along.
const SERVICE = /^((npm|pnpm|yarn|bun) (run )?(dev|start|serve|preview|watch)([:\w-]*)|node [\w./\\-]+\.(c|m)?js|npx (vite|next (dev|start)|serve|http-server|astro dev|nodemon)|python3? (-m (http\.server|flask run|uvicorn)|manage\.py runserver|[\w./\\-]+\.py)|uvicorn [\w.:]+|flask run|php -S [\w.:]+|go run [\w./-]+|cargo run|rails s(erver)?)( [\w.:=/@-]+)*$/

const live = new Map()   // service id -> { child, ring, watchers }

export const logPath = id => join(LOG_DIR, `service-${id}.log`)
const row = id => get('SELECT * FROM services WHERE id = ?', id)
const changed = s => { emit('service', s.project_id, s); return s }

export function listServices(project_id) {
  return all('SELECT * FROM services WHERE project_id = ? ORDER BY status = \'running\' DESC, id DESC LIMIT 20', project_id)
}

export function startService(project_id, { name, command }) {
  name = String(name || '').trim().slice(0, 40)
  command = String(command || '').trim()
  if (!name) throw new Error('Give the service a short name, for example "web" or "api".')
  if (!SERVICE.test(command)) throw new Error(`"${command}" is not a single serve or dev command (like "npm run dev" or "node server.js"). Ask the owner to start it themselves.`)
  const running = get('SELECT * FROM services WHERE project_id = ? AND name = ? AND status = \'running\'', project_id, name)
  if (running) return { service: running, already: true }
  const project = getProject(project_id)
  if (!project.local_path) throw new Error('The repo is not cloned yet.')
  const id = insert('services', { project_id, name, command })
  spawnService(row(id), project.local_path)
  return { service: changed(row(id)), already: false }
}

function spawnService(s, cwd) {
  const [shell, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', s.command]] : ['/bin/sh', ['-c', s.command]]
  mkdirSync(LOG_DIR, { recursive: true })
  const entry = { child: null, ring: '', watchers: new Set(), log: createWriteStream(logPath(s.id), { flags: 'a' }) }
  live.set(s.id, entry)
  try {
    entry.child = pty.spawn(shell, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: { ...childEnv(), FORCE_COLOR: '1' } })
  } catch (err) {
    live.delete(s.id)
    entry.log.end()
    update('services', s.id, { status: 'exited', ended_at: now() })
    throw new Error(`Could not start: ${err.message}`)
  }
  entry.child.onData(d => {
    entry.ring = (entry.ring + d).slice(-RING)
    entry.log.write(d)
    for (const w of entry.watchers) w(d)
    if (!entry.url) {
      const m = d.replace(ANSI, '').match(URL_RE)
      if (m) { entry.url = m[0].replace('0.0.0.0', 'localhost'); update('services', s.id, { url: entry.url }); changed(row(s.id)) }
    }
  })
  entry.child.onExit(({ exitCode }) => {
    live.delete(s.id)
    entry.log.end()
    // The row is settled before watchers hear about it: a restart waiting on this must not find it still running.
    const cur = row(s.id)
    if (cur?.status === 'running') update('services', s.id, { status: entry.stopping ? 'stopped' : 'exited', exit_code: exitCode, ended_at: now() })
    for (const w of entry.watchers) w(null)
    if (cur) changed(row(s.id))
  })
}

export function stopService(id) {
  const s = row(id)
  if (!s) throw new Error('No such service')
  const e = live.get(id)
  if (e) { e.stopping = true; killChild(e.child) }
  else if (s.status === 'running') {
    update('services', id, { status: 'stopped', ended_at: now() })
    changed(row(id))
  }
  return s
}

export function restartService(id) {
  const s = row(id)
  if (!s) throw new Error('No such service')
  const e = live.get(id)
  const again = () => startService(s.project_id, { name: s.name, command: s.command }).service
  if (!e) return again()
  // Start the new one only once the old process has let go of its port.
  return new Promise(resolve => {
    e.watchers.add(d => { if (d === null) resolve(again()) })
    e.stopping = true
    killChild(e.child)
  })
}

export function removeService(id) {
  const s = row(id)
  if (!s) return
  if (live.has(id)) throw new Error('Stop it first')
  run('DELETE FROM services WHERE id = ?', id)
  emit('service', s.project_id, { id, deleted: true })
}

// Live log: buffered output, then chunks; null when the process ends. Null when the service is not running.
export function watchService(id, fn) {
  const e = live.get(id)
  if (!e) return null
  fn(e.ring)
  e.watchers.add(fn)
  return () => e.watchers.delete(fn)
}

export function serviceTail(id, max = RING) {
  const p = logPath(id)
  if (!existsSync(p)) return ''
  const fd = openSync(p, 'r')
  try {
    const size = fstatSync(fd).size, n = Math.min(size, max)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)
    return buf.toString('utf8')
  } finally { closeSync(fd) }
}

// Plain text for agents: the last lines without colour codes.
export function serviceText(id, lines = 60) {
  const e = live.get(id)
  const text = (e ? e.ring : serviceTail(id, 64 * 1024)).replace(ANSI, '').replace(/\r(?!\n)/g, '\n')
  return text.split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-Math.min(Math.max(lines, 1), 400)).join('\n')
}

// Processes from a previous server run are gone; their rows say so.
export function recoverServices() {
  run(`UPDATE services SET status = 'stopped', ended_at = ? WHERE status = 'running'`, now())
}

// Services die with the crew server rather than outliving it as orphans holding ports.
export function stopAllServices() {
  for (const [, e] of live) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(e.child.pid), '/T', '/F'], { stdio: 'ignore' })
      else e.child.kill('SIGKILL')
    } catch {}
  }
}
