// Asiel Farm Shop — Service Worker v2
// Deploy this file at /sw.js (web root, same origin as the app)

const CACHE_NAME = 'asiel-farm-shop-v2';
const API_CACHE  = 'asiel-api-v2';
const STATIC_ASSETS = ['/', '/index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(STATIC_ASSETS))
      // Log rather than silently swallow — broken offline shell is worse than a failed install
      .catch(err => console.warn('[SW] Failed to precache static assets:', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== API_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/products')) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE, 5000));
    return;
  }
  event.respondWith(cacheFirst(request, CACHE_NAME));
});

self.addEventListener('sync', event => {
  if (event.tag === 'order-queue') event.waitUntil(replayOrderQueue());
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }

  const { title = 'Asiel Farm Shop', body = '', data = {} } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data,
      tag: data.orderId || 'asiel',     // collapse duplicate order notifications
      renotify: true,
      requireInteraction: data.status === 'delivered', // keep delivered notification until tapped
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      const match = wins.find(w => w.url.includes(self.location.origin));
      if (match) return match.focus().then(w => w.navigate(url));
      return clients.openWindow(url);
    })
  );
});

// Each order is replayed independently so one failure doesn't block others.
// The IDB transaction is re-opened per item to avoid auto-close across async gaps.
async function replayOrderQueue() {
  const db = await openOrderQueue();

  // Read all queued items in a single read-only transaction
  const items = await new Promise((res, rej) => {
    const tx  = db.transaction('queue', 'readonly');
    const req = tx.objectStore('queue').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });

  for (const item of items) {
    try {
      const resp = await fetch(item.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    item.body,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // Delete in its own transaction after confirmed success
      await new Promise((res, rej) => {
        const tx  = db.transaction('queue', 'readwrite');
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
        tx.objectStore('queue').delete(item.id);
      });
    } catch (err) {
      // Log and continue — remaining orders should still be attempted
      console.error('[SW] Order replay failed for item', item.id, ':', err.message);
    }
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) { const c = await caches.open(cacheName); c.put(req, fresh.clone()); }
    return fresh;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req, cacheName, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fresh = await fetch(req, { signal: controller.signal });
    if (fresh.ok) { const c = await caches.open(cacheName); c.put(req, fresh.clone()); }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response('{"error":"offline"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    // Always clear regardless of outcome — prevents abort firing after response is handled
    clearTimeout(timer);
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cached = await caches.match(req);
  const fetchPromise = fetch(req).then(fresh => {
    if (fresh.ok) caches.open(cacheName).then(c => c.put(req, fresh.clone()));
    return fresh;
  }).catch(() => cached); // Fall back to cached copy if revalidation fetch fails
  return cached || fetchPromise;
}

function openOrderQueue() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('asiel-order-queue', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
