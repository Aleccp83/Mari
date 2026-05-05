// ================================================================
// SERVICE WORKER — Argus GIS PWA v2.0
// Strategia: Cache-First per asset statici, Network-Only per API
// ================================================================

const CACHE_NAME = 'argus-v2.1';  // bump versione → forza aggiornamento cache

const STATIC_ASSETS = [
  './index.html',
  './style.css',
  './script.js',
  './manifest.json'
];

// ── INSTALL ──────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[Argus SW] Installing v2.0...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[Argus SW] Pre-cache parziale:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[Argus SW] Activating, cleaning old caches...');
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH ────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Hosts dinamici: sempre dalla rete, mai cachati
  const dynamicHosts = [
    'nominatim.openstreetmap.org',
    'tile.openstreetmap.org',
    'opentopomap.org',
    'arcgisonline.com',
    'arcgis.com',
    'sentinel.arcgis.com',
    'overpass-api.de',
    'agenziaentrate.gov.it',
    'unpkg.com',
    'cdn.jsdelivr.net'
  ];

  const isDynamic = dynamicHosts.some((h) => url.hostname.includes(h));

  if (isDynamic) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response('{"error":"offline"}', {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Cache-First per asset locali
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      if (event.request.destination === 'document') {
        return caches.match('./index.html');
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
