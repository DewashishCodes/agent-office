self.addEventListener('push', e => {
  let d = {}
  try { d = e.data.json() } catch { d = { body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'Agent Office', {
    body: d.body || '', icon: '/icon.svg', badge: '/icon.svg', data: { url: d.url || '/', item: d.item }, actions: d.actions || [],
  }))
})

async function openApp(url) {
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true })
  const c = list.find(c => c.url.startsWith(self.location.origin))
  if (!c) return clients.openWindow(url)
  await c.focus()
  // navigate() rejects for uncontrolled clients; a focused app is still better than nothing.
  if (c.url !== url) await c.navigate(url).catch(() => {})
}

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const { item } = e.notification.data || {}
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href
  e.waitUntil((async () => {
    // Approve or Merge straight from the notification; the login cookie goes along. Anything that fails opens the card.
    if (e.action && item) {
      const res = await fetch(`/api/inbox/${item}/action`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: e.action }),
      }).catch(() => null)
      if (res?.ok) return self.registration.showNotification(e.action === 'merge' ? 'Merged' : 'Plan approved', { body: e.notification.title, icon: '/icon.svg', tag: `done-${item}` })
    }
    return openApp(url)
  })())
})
