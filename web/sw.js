// Version: 3.3.4 - 2025-10-29 22.37.48
// © Christian Vemmelund Helligsø
const CACHE_NAME = 'dofnot-v3.3.4';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install: precache core
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => 
      cache.addAll(CORE_ASSETS)
    )
  );
  self.skipWaiting();
});

// Activate: cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key.startsWith('dofnot-v') && key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Aldrig cache noget under /obs
  if (url.pathname.startsWith('/obs/')) {
    // Network only
    event.respondWith(fetch(req));
    return;
  }

  // Only handle same-origin GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const isAPI = url.pathname.startsWith('/api/');
  if (isAPI) {
    // Network-first for API
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Static: cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => {
        // Fallback to cached index for navigation requests
        if (req.mode === 'navigate') return caches.match('/index.html');
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    })
  );
});

// Vis notifikation når push modtages
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Ny besked', body: event.data ? event.data.text() : 'Ny notifikation' };
  }
  const title = payload.title || 'DOF Notifikation';
  const options = {
    body: payload.body || JSON.stringify(payload),
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload,
    tag: payload.tag || undefined // <-- tilføj denne linje
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  console.log("Åbner URL fra push:", url); // DEBUG
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});