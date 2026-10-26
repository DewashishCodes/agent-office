import express from 'express'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { get, run, DATA_DIR } from './db.js'
import { teeConsole } from './logfile.js'
import { bus } from './bus.js'
import { hookEvent } from './runner.js'
import { start } from './scheduler.js'
import { initNotify, publicKey } from './notify.js'
import { mcpHandler } from './crewmcp.js'
import { loginLimiter } from './rules.js'
import { ensureSupport } from './support.js'
import { recoverServices, stopAllServices } from './services.js'
import { fail, isObj } from './http.js'
import projects from './routes/projects.js'
import orders from './routes/orders.js'
import runs from './routes/runs.js'
import support from './routes/support.js'
import vault from './routes/vault.js'
import agents from './routes/agents.js'
import inbox from './routes/inbox.js'

// First boot (or the example value): make the owner token, keep it in .env and say it once, instead of refusing to start.
if (!process.env.OWNER_TOKEN || process.env.OWNER_TOKEN === 'change-me-to-a-long-random-string') {
  const env = join(import.meta.dirname, '..', '.env')
  const token = randomBytes(24).toString('base64url')
  const old = existsSync(env) ? readFileSync(env, 'utf8') : ''
  writeFileSync(env, /^OWNER_TOKEN=.*$/m.test(old)
    ? old.replace(/^OWNER_TOKEN=.*$/m, `OWNER_TOKEN=${token}`)
    : `${old}${old && !old.endsWith('\n') ? '\n' : ''}OWNER_TOKEN=${token}\n`)
  process.env.OWNER_TOKEN = token
  console.log(`\nNo owner token was set, so one was made and saved in .env. Log in with:\n\n  ${token}\n\nat http://localhost:${process.env.PORT || 5190} (from your phone, see Phone access in the README).\n`)
}

const sha = s => createHash('sha256').update(s).digest()
const MAX_AGE = 30 * 24 * 3600 * 1000
// Looked up by its hash, so the comparison never runs on bytes the client chose.
const sessionId = req => sha((req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('crew='))?.slice(5) || '').toString('hex')

export const app = express()
// Only a local proxy (Tailscale Serve) may set X-Forwarded-*; otherwise a client could pick its own IP for the login limit.
app.set('trust proxy', 'loopback')

// Hooks and the status line of terminal runs (server/hook.mjs): loopback, the per-run token and the run's hook secret header.
// Before the global parser: a PermissionRequest for a big Write carries the whole file.
app.post('/hook/:token', express.json({ limit: '50mb' }), async (req, res) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.status(403).end()
  const out = await hookEvent(req.params.token, req.query.kind, req.body, req.get('x-crew-hook'))
  if (typeof out === 'string') res.type('text').send(out)
  else res.json(out)
})

app.use(express.json({ limit: '1mb' }))

// Crew MCP for agent sessions on this host; auth is the per-run token, not the owner cookie.
app.all('/mcp/:token', mcpHandler)

const logins = loginLimiter()
app.post('/api/login', (req, res) => {
  if (logins.blocked(req.ip)) throw fail(429, 'too many wrong tokens, try again in 15 minutes')
  const token = req.body?.token
  if (typeof token !== 'string' || !timingSafeEqual(sha(token), sha(process.env.OWNER_TOKEN))) {
    logins.miss(req.ip)
    throw fail(401, 'wrong token')
  }
  logins.clear(req.ip)
  const sid = randomBytes(32).toString('hex')
  run('INSERT INTO sessions (id) VALUES (?)', sha(sid).toString('hex'))
  res.cookie('crew', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE })
  res.json({ ok: true })
})

// Health for a service manager or a curl on this machine: loopback without a cookie, everyone else logs in first.
// Tailscale Serve proxies from loopback too, so a forwarded request is not local.
const health = (req, res) => res.json({
  ok: true, uptime: Math.round(process.uptime()), projects: get('SELECT COUNT(*) n FROM projects').n,
  running_runs: get(`SELECT COUNT(*) n FROM runs WHERE status = 'running'`).n,
})
app.get('/api/health', (req, res, next) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] ? health(req, res) : next())

app.use('/api', (req, res, next) => {
  if (!get(`SELECT 1 FROM sessions WHERE id = ? AND created_at > datetime('now', ?)`, sessionId(req), `-${MAX_AGE / 1000} seconds`)) throw fail(401, 'not logged in')
  next()
})

// running stays 1 in kv until a clean exit, so the next boot knows the last one crashed, lost power or slept.
const booted = Date.now(), unclean = get(`SELECT value FROM kv WHERE key = 'running'`)?.value === '1'
// restarted: an unclean restart under a minute ago, for a one-line hint in the UI.
app.get('/api/health', health)

// A consistent copy of the whole database: VACUUM INTO snapshots it even while runs write, then it streams and goes.
app.get('/api/backup', (req, res) => {
  const file = join(DATA_DIR, `backup-${Date.now()}.db`)
  run('VACUUM INTO ?', file)
  res.download(file, `agent-office-${new Date().toLocaleDateString('sv')}.db`, () => rmSync(file, { force: true }))
})

app.get('/api/me', (req, res) => res.json({ ok: true, restarted: unclean && Date.now() - booted < 60000 }))
// all: true signs out every browser and phone, for a lost device or a leaked cookie.
app.post('/api/logout', (req, res) => {
  if (req.body?.all) run('DELETE FROM sessions')
  else run('DELETE FROM sessions WHERE id = ?', sessionId(req))
  res.clearCookie('crew')
  res.json({ ok: true })
})

// Routes by domain, all behind the cookie check above.
for (const r of [projects, orders, runs, support, vault, agents, inbox]) app.use(r)

// Live events and push

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write(': connected\n\n')
  const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`)
  const beat = setInterval(() => res.write(': ping\n\n'), 25000)
  bus.on('event', send)
  req.on('close', () => { clearInterval(beat); bus.off('event', send) })
})

app.get('/api/push/key', (req, res) => res.json({ publicKey: publicKey() }))

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body?.subscription
  if (!isObj(sub) || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !isObj(sub.keys)) throw fail(400, 'invalid subscription')
  run('INSERT INTO push_subs (endpoint, sub) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub', sub.endpoint, JSON.stringify(sub))
  res.json({ ok: true })
})

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }))

// Web app

const DIST = join(import.meta.dirname, '..', 'web', 'dist')
// index.html names the hashed bundles, so it must be revalidated or a browser keeps running the previous build.
const fresh = res => res.setHeader('Cache-Control', 'no-cache')
app.use(express.static(DIST, { setHeaders: (res, p) => p.endsWith('.html') && fresh(res) }))
app.get('/{*any}', (req, res, next) => { fresh(res); res.sendFile(join(DIST, 'index.html'), e => e && next(fail(404, 'web app not built, run npm run build'))) })

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500) console.error(err)
  res.status(status).json({ error: status >= 500 && !err.message ? 'server error' : err.message })
})

if (import.meta.main) {
  // After the first-boot token message, so the token never lands in the log file.
  teeConsole(join(DATA_DIR, 'server.log'))
  const port = process.env.PORT || 5190
  // Boot recovery and the scheduler only start once the port is ours: a second server on the same data/ would
  // otherwise reset the first one's running tasks and start runs nobody can reach.
  // Express 5 calls this on a listen error too, with the error.
  app.listen(port, err => {
    if (err) {
      console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use: is Agent Office already running? Set PORT in .env to run a second copy.` : err.message)
      process.exit(1)
    }
    ensureSupport()
    recoverServices()
    run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('running', '1')`)
    // A crash exits non-zero and still fires 'exit'; only a clean stop clears the flag.
    process.on('exit', code => { stopAllServices(); if (code === 0) run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('running', '0')`) })
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))
    initNotify()
    start()
    console.log(`Agent Office on http://localhost:${port}`)
  })
}
