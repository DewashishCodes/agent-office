// npm run doctor: checks what the crew needs on this machine and says how to fix what is missing.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const run = (cmd, args) => new Promise(ok => execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) =>
  ok({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() })))

const checks = [
  ['Node 24 or newer', async () => {
    const major = Number(process.versions.node.split('.')[0])
    return major >= 24 ? [true, process.version] : [false, `${process.version}. Install Node 24 from https://nodejs.org`]
  }],
  ['git', async () => {
    const r = await run('git', ['--version'])
    return r.ok ? [true, r.out] : [false, 'not found. Install git from https://git-scm.com and reopen the terminal']
  }],
  ['claude CLI', async () => {
    const bin = process.env.CREW_CLAUDE_PTY_BIN || 'claude'
    const r = await run(bin, ['--version'])
    return r.ok ? [true, `${r.out} (${bin})`] : [false, `${bin} not found. Install the native Claude Code binary, run claude once to log in, or set CREW_CLAUDE_PTY_BIN`]
  }],
  ['gh logged in with repo scope', async () => {
    const r = await run('gh', ['auth', 'status'])
    if (!r.ok && /not found|ENOENT/i.test(r.out)) return [false, 'gh not found. Install it from https://cli.github.com']
    if (!r.ok) return [false, 'not logged in. Run: gh auth login']
    return /'repo'|\brepo\b/.test(r.out) ? [true, 'logged in'] : [false, 'token lacks the repo scope. Run: gh auth refresh -s repo']
  }],
  ['owner token', async () => {
    const env = join(import.meta.dirname, '..', '.env')
    const m = existsSync(env) && readFileSync(env, 'utf8').match(/^OWNER_TOKEN=(.+)$/m)
    if (!m || m[1].trim() === 'change-me-to-a-long-random-string') return [true, 'not set yet; npm start makes one and prints it']
    return m[1].trim().length >= 24 ? [true, 'set in .env'] : [false, 'shorter than 24 characters. Delete the line and npm start makes a long one']
  }],
  ['web build', async () => existsSync(join(import.meta.dirname, '..', 'web', 'dist', 'index.html'))
    ? [true, 'web/dist is there'] : [false, 'missing. Run: npm run build']],
]

let bad = 0
for (const [name, check] of checks) {
  const [ok, note] = await check().catch(e => [false, e.message])
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FIX '} ${name}: ${note}`)
}
console.log(bad ? `\n${bad} thing${bad === 1 ? '' : 's'} to fix before the crew can work.` : '\nAll set. Run npm start.')
process.exit(bad ? 1 : 0)
