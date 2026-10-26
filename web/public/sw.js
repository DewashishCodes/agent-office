// Offline shell: index.html, its hashed bundles and the font, so the app opens when the office is out of reach.
// shortcut: bundles of older builds stay in the cache (a few hundred KB each); bump SHELL to clear them if it ever matters.
const SHELL = 'shell-v1'
const STATIC = /^\/(assets|fonts|clawd)\//

self.addEventListener('install', e => {
  self.skipWaiting()
  // A failed precache must not fail the install: push notifications need this worker either way.
  e.waitUntil((async () => {
    try {
      const c = await caches.open(SHELL)
      const res = await fetch('/', { cache: 'no-store' })
      const html = await res.clone().text()
      await c.put('/', res)
      await c.addAll([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]).concat('/fonts/silkscreen-latin.woff2', '/favicon.svg', '/icon.svg'))
    } catch {}
  })())
})

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k)
  await self.clients.claim()
})()))

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put('/', copy)) }
      return res
    }, () => caches.match('/')))
  } else if (STATIC.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)) }
      return res
    })))
  }
})

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
