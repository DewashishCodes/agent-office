self.addEventListener('push', e => {
  let d = {}
  try { d = e.data.json() } catch { d = { body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'Agent Crew', {
    body: d.body || '', icon: '/icon.svg', badge: '/icon.svg', data: { url: d.url || '/' },
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const c = list.find(c => c.url.startsWith(self.location.origin))
    if (!c) return clients.openWindow(url)
    await c.focus()
    // navigate() rejects for uncontrolled clients; a focused app is still better than nothing.
    if (c.url !== url) await c.navigate(url).catch(() => {})
  })())
})
