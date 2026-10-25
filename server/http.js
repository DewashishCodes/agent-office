// Request helpers shared by the route modules: errors with a status, id and body checks, row lookups.
import { getProject, getAgent, log } from './db.js'
import { floorOf } from './roster.js'

export const fail = (status, message) => Object.assign(new Error(message), { status })
export const int = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw fail(400, 'bad id'); return n }
export const found = (row, what) => { if (!row) throw fail(404, `${what} not found`); return row }
export const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
export const isStrs = v => Array.isArray(v) && v.every(s => typeof s === 'string')
export const str = (v, what) => { if (typeof v !== 'string' || !v.trim()) throw fail(400, `${what} is required`); return v }

// Long work reports through SSE; errors still land in the activity feed.
export const background = (project_id, p) => Promise.resolve(p).catch(e => { console.error(e); log(project_id, 'error', e.message) })

export const project = req => found(getProject(int(req.params.id)), 'project')
export const agent = req => { const a = getAgent(int(req.params.id)); if (!a || a.removed_at) throw fail(404, 'agent not found'); return a }

export const count = (min, max = Infinity) => v => Number.isInteger(v) && v >= min && v <= max
export const regex = v => { try { return typeof v === 'string' && v.length < 4000 && !!new RegExp(v) } catch { return false } }

export const floorKey = v => v == null || v === '' ? 'tech' : floorOf(v)?.key ?? (() => { throw fail(400, `unknown floor ${v}`) })()

// What an order has cost so far: every run of its tasks, review and QA included.
export const ORDER_COST = `(SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE order_id = o.id)) cost_usd`
