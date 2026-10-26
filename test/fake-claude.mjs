// Stand-in for the claude CLI in stream-json mode. Echoes each user message; "ASK" triggers a Bash permission prompt.
import { createInterface } from 'node:readline'

const out = o => process.stdout.write(JSON.stringify(o) + '\n')
const sid = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : 'sess-1'
let turn = 0
const pending = new Map()

function reply(text) {
  turn++
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0.01 * turn, usage: { input_tokens: 10, output_tokens: 5 } })
}

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.type === 'control_request' && m.request.subtype === 'initialize') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } })
    return out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, usage: {} })
  }
  if (m.type === 'control_response') {
    const r = m.response.response
    pending.delete(m.response.request_id)
    return reply(r.behavior === 'allow' ? `allowed ${r.updatedInput.command}` : `denied: ${r.message}`)
  }
  if (m.type !== 'user') return
  out({ type: 'system', subtype: 'init', session_id: sid })
  out({ type: 'user', message: { role: 'user', content: m.message.content } })
  const text = m.message.content
  if (text.includes('MCP')) return reply(process.argv[process.argv.indexOf('--mcp-config') + 1])
  if (text.includes('HANG')) return out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 100' } }] } })
  if (text.includes('LIMITS')) out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1 }, seven_day: { utilization: 0.6, resetsAt: 2 } } } })
  if (text.includes('ASK')) {
    pending.set('perm-1', true)
    return out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'curl example.com' } } })
  }
  reply(`got: ${text}`)
})
