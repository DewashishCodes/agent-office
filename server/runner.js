import { spawn, execFile } from 'node:child_process'
import { relative, isAbsolute, join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { insert, update, get, run, getAgent, setAgent, now, DATA_DIR } from './db.js'
import { emit } from './bus.js'

// run_id -> { child, project_id, killed }
const children = new Map()

const AGENT_KINDS = ['task', 'review', 'qa']

// Short live status line for a tool call, e.g. "Edit web/App.jsx" or "Bash npm test".
function describe(name, input = {}, cwd) {
  let arg = input.file_path || input.notebook_path || input.path || input.command || input.pattern || input.url || input.description || ''
  if (typeof arg !== 'string') arg = ''
  if ((input.file_path || input.notebook_path || input.path) && isAbsolute(arg)) {
    const r = relative(cwd, arg)
    if (r && !r.startsWith('..')) arg = r
  }
  arg = arg.replaceAll('\\', '/').split('\n')[0]
  return `${name} ${arg}`.trim().slice(0, 200)
}

function runRow(id) { return get('SELECT * FROM runs WHERE id = ?', id) }

function settleAgent(agent_id) {
  if (!agent_id) return
  const a = getAgent(agent_id)
  if (a?.status === 'working' && runningCount(agent_id) === 0) setAgent(agent_id, { status: 'idle' })
}

export function runClaude({
  project_id, agent_id = null, task_id = null, kind, cwd, prompt, systemPrompt,
  model = 'sonnet', effort = 'medium', allowedTools = [], disallowedTools = [],
  permissionMode = 'dontAsk', resume = null,
}) {
  const run_id = insert('runs', { project_id, agent_id, task_id, kind })
  if (agent_id && AGENT_KINDS.includes(kind) && getAgent(agent_id)?.status !== 'paused') setAgent(agent_id, { status: 'working' })
  emit('run', project_id, runRow(run_id))

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config',
    '--model', model, '--effort', effort, '--permission-mode', permissionMode]
  // Via a file: Windows caps a command line at about 32k chars and prompts with CLAUDE.md get long.
  const spFile = systemPrompt && join(DATA_DIR, 'prompts', `run-${run_id}.txt`)
  if (spFile) {
    mkdirSync(join(DATA_DIR, 'prompts'), { recursive: true })
    writeFileSync(spFile, systemPrompt)
    args.push('--append-system-prompt-file', spFile)
  }
  // Comma-joined single arg: the flags are variadic and would swallow following args.
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','))
  if (disallowedTools.length) args.push('--disallowedTools', disallowedTools.join(','))
  if (resume) args.push('--resume', resume)

  // Nested sessions refuse to start when the server itself runs inside Claude Code.
  const env = { ...process.env }
  delete env.CLAUDECODE

  return new Promise(resolve => {
    let buf = '', stderr = '', result = null, session_id = null, lastText = ''
    let lastEmit = 0, timer = null, done = false, child
    try { child = spawn('claude', args, { cwd, env, windowsHide: true }) } catch (e) { return finish(null, e.message) }
    const entry = { child, project_id, killed: false }
    children.set(run_id, entry)

    const flush = () => { timer = null; lastEmit = Date.now(); emit('run', project_id, runRow(run_id)) }
    const throttledEmit = () => {
      if (timer) return
      const wait = 1000 - (Date.now() - lastEmit)
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    }

    function onLine(line) {
      if (!line.trim()) return
      let m
      try { m = JSON.parse(line) } catch { return }
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        session_id = m.session_id
        update('runs', run_id, { session_id })
      } else if (m.type === 'assistant') {
        for (const c of m.message?.content || []) {
          if (c.type === 'text' && c.text) lastText = c.text
          if (c.type === 'tool_use') {
            update('runs', run_id, { last_event: describe(c.name, c.input, cwd) })
            throttledEmit()
          }
        }
      } else if (m.type === 'rate_limit_event') {
        const w = m.rate_limit_info?.unifiedWindows?.five_hour
        if (w?.utilization != null) {
          const value = JSON.stringify({ utilization: w.utilization, resetsAt: w.resetsAt ?? m.rate_limit_info.resetsAt ?? null, at: now() })
          run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'rate_limit', value)
        }
      } else if (m.type === 'result') {
        result = m
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) onLine(l)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt ?? '')
    child.on('error', e => { stderr += e.message; finish(entry, null) })
    child.on('close', code => {
      if (buf) onLine(buf)
      finish(entry, null, code)
    })

    function finish(entry, spawnError, code) {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      children.delete(run_id)
      if (spFile) rmSync(spFile, { force: true })
      const u = result?.usage || {}
      const input_tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      const output_tokens = u.output_tokens || 0
      const cost_usd = result?.total_cost_usd || 0
      session_id = result?.session_id || session_id
      const ok = !!result && !result.is_error && !entry?.killed
      const text = result?.result ?? (lastText || spawnError || stderr.trim() || `claude exited with code ${code}`)
      const status = entry?.killed ? 'killed' : ok ? 'ok' : 'error'
      update('runs', run_id, { status, session_id, input_tokens, output_tokens, cost_usd, result_text: text, ended_at: now() })
      emit('run', project_id, runRow(run_id))
      settleAgent(agent_id)
      resolve({ ok, text, session_id, input_tokens, output_tokens, cost_usd, run_id })
    }
  })
}

export function killRun(run_id) {
  const e = children.get(run_id)
  if (!e) return
  e.killed = true
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(e.child.pid), '/T', '/F'], () => {})
  else e.child.kill('SIGKILL')
}

export function killProject(project_id) {
  for (const [id, e] of children) if (e.project_id === project_id) killRun(id)
  // Rows left 'running' by a previous server process have no child to kill.
  run(`UPDATE runs SET status = 'killed', ended_at = ? WHERE project_id = ? AND status = 'running'`, now(), project_id)
}

// started_at is UTC; compare against local midnight converted to the same format.
function todayStart() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

export const tokensToday = agent_id =>
  get('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', agent_id, todayStart()).n

export const projectTokensToday = project_id =>
  get('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM runs WHERE project_id = ? AND started_at >= ?', project_id, todayStart()).n

export const runningCount = agent_id =>
  get(`SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'running'`, agent_id).n
