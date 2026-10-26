import webpush from 'web-push'
import { all, get, run, log } from './db.js'
import { bus } from './bus.js'

const kvGet = key => get('SELECT value FROM kv WHERE key = ?', key)?.value
const kvSet = (key, value) => run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
const localDate = () => new Date().toLocaleDateString('en-CA')

let keys

export function initNotify() {
  // Generated once: rotating VAPID keys would invalidate every existing subscription.
  keys = JSON.parse(kvGet('vapid') || 'null')
  if (!keys) kvSet('vapid', JSON.stringify(keys = webpush.generateVAPIDKeys()))
  webpush.setVapidDetails('mailto:crew@localhost', keys.publicKey, keys.privateKey)
  bus.on('event', e => {
    if (e.type !== 'inbox' || !e.data.created) return
    const i = e.data
    // Approve and Merge act from the notification itself (web/public/sw.js); anything needing words opens the card.
    const actions = i.kind === 'plan' ? [{ action: 'approve', title: 'Approve' }] : i.kind === 'merge' && i.task_id ? [{ action: 'merge', title: 'Merge' }] : []
    sendPush(i.title, i.body || '', `/#/inbox/${i.id}/${i.project_id}`, { item: i.id, actions })
  })
  setInterval(digestTick, 10 * 60 * 1000).unref()
}

export const publicKey = () => keys?.publicKey

export async function sendPush(title, body, url = '/', extra = {}) {
  const payload = JSON.stringify({ title, body, url, ...extra })
  await Promise.all(all('SELECT * FROM push_subs').map(s =>
    webpush.sendNotification(s.sub, payload).catch(e => {
      if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subs WHERE id = ?', s.id)
      else console.error('push failed', e.statusCode || e.message)
    })))
}

// "Yesterday" is the last 24 hours: the digest runs once in the morning, so that covers the previous day.
export function digestNow(project_id) {
  const since = "datetime('now', '-1 day')"
  const done = all(`SELECT title, merged FROM tasks WHERE project_id = ? AND status = 'done' AND updated_at >= ${since}`, project_id)
  const review = get("SELECT count(*) n FROM tasks WHERE project_id = ? AND status IN ('in_review', 'qa')", project_id).n
  const inbox = get("SELECT count(*) n FROM inbox WHERE project_id = ? AND status = 'open'", project_id).n
  const tokens = get(`SELECT coalesce(sum(input_tokens + output_tokens), 0) n FROM runs WHERE project_id = ? AND started_at >= ${since}`, project_id).n
  const lines = [
    `Done: ${done.length} (${done.filter(t => t.merged).length} merged)`,
    ...done.map(t => `- ${t.title}${t.merged ? ' (merged)' : ''}`),
    `In review: ${review}`,
    `Open inbox: ${inbox}`,
    `Tokens used: ${tokens}`,
  ]
  const text = lines.join('\n')
  log(project_id, 'digest', text)
  sendPush('Daily digest', lines.filter(l => !l.startsWith('- ')).join(', '), '/#/board')
  return text
}

function digestTick() {
  const hour = new Date().getHours(), date = localDate()
  for (const p of all('SELECT id, settings FROM projects')) {
    if (p.settings.digest_hour !== hour || kvGet(`digest:${p.id}`) === date) continue
    kvSet(`digest:${p.id}`, date)
    try { digestNow(p.id) } catch (e) { console.error('digest failed', p.id, e.message) }
  }
}
