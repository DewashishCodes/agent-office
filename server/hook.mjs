// Hook and status line bridge for terminal runs: stdin JSON goes to the crew server, its reply goes to stdout.
// node:http instead of fetch: a permission answer can take the owner longer than fetch's 5 minute header timeout.
import { request } from 'node:http'

const [url, kind] = process.argv.slice(2)
let body = ''
for await (const c of process.stdin) body += c

const req = request(`${url}?kind=${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
  let out = ''
  res.setEncoding('utf8')
  res.on('data', d => { out += d })
  res.on('end', () => process.stdout.write(out))
})
// Server down: print nothing, so the CLI falls back to its own prompt in the terminal.
req.on('error', () => process.exit(0))
req.end(body || '{}')
