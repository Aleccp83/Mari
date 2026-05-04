// ================================================================
// SERVICE WORKER — EcoMonitor Pro PWA
// Strategia: Cache-First per asset statici, Network-First per API
// ================================================================

const CACHE_NAME = 'ecomonitor-v1.0';

// Asset statici da pre-cachare all'installazione
const STATIC_ASSETS = [
  './index.html',
  './style.css',
  './script.js',
  './manifest.json'
];

// ── INSTALL ──────────────────────────────────────────────────────
// Pre-cacha le risorse locali essenziali per il funzionamento offline
self.addEventListener('install', (event) => {
  console.log('[SW] Installing EcoMonitor Pro v1.0...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Pre-cache parziale:', err);
      });
    })
  );
  // Forza attivazione immediata senza aspettare la chiusura delle tab
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────
// Rimuove le versioni di cache precedenti per liberare spazio
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating, cleaning old caches...');
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      )
    )
  );
  self.clients.claim();
});

// ── FETCH ────────────────────────────────────────────────────────
// Routing intelligente delle richieste
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Lista di hostname che NON devono essere cachati (dati dinamici/API)
  const dynamicHosts = [
    'nominatim.openstreetmap.org',
    'tile.openstreetmap.org',
    'services.sentinel-hub.com',
    'geoserver.geoportale.it',
    'wms.cartografia.agenziaentrate.gov.it',
    'overpass-api.de',
    'earthengine.googleapis.com'
  ];

  const isDynamic = dynamicHosts.some((host) => url.hostname.includes(host));

  if (isDynamic) {
    // Network-Only per API esterne: dati sempre freschi
    event.respondWith(
      fetch(event.request).catch(() => {
        // Fallback silenzioso se offline
        return new Response(JSON.stringify({ error: 'Offline: dati non disponibili' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Cache-First per asset statici locali
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // Cacha solo risposte valide
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Fallback alla pagina principale se offline
      if (event.request.destination === 'document') {
        return caches.match('./index.html');
      }
    })
  );
});

// ── MESSAGE HANDLER ──────────────────────────────────────────────
// Permette all'app di forzare l'aggiornamento del SW
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
