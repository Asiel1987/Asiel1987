// Asiel Farm Shop — Service Worker v1
// Deploy this file at /sw.js (web root, same origin as the app)

const CACHE_NAME = 'asiel-farm-shop-v1';
const API_CACHE  = 'asiel-api-v1';
const STATIC_ASSETS = ['/', '/index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(STATIC_ASSETS).catch(() => {}))
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

async function replayOrderQueue() {
  const db = await openOrderQueue();
  const tx = db.transaction('queue', 'readwrite');
  const all = await tx.objectStore('queue').getAll();
  for (const item of all) {
    try {
      await fetch(item.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: item.body });
      await tx.objectStore('queue').delete(item.id);
    } catch {}
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) { const c = await caches.open(cacheName); c.put(req, fresh.clone()); }
    return fresh;
  } catch { return new Response('Offline', { status: 503 }); }
}

async function networkFirst(req, cacheName, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fresh = await fetch(req, { signal: controller.signal });
    clearTimeout(timer);
    if (fresh.ok) { const c = await caches.open(cacheName); c.put(req, fresh.clone()); }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cached = await caches.match(req);
  const fetchPromise = fetch(req).then(fresh => {
    if (fresh.ok) caches.open(cacheName).then(c => c.put(req, fresh.clone()));
    return fresh;
  }).catch(() => {});
  return cached || fetchPromise;
}

function openOrderQueue() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('asiel-order-queue', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e);
  });
}
