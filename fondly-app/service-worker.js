// Fondly service worker
// Purpose: make the app installable (PWA) and cache the static app shell
// so pages load instantly on repeat visits. All API calls (different origin,
// e.g. http://localhost:3000) are always sent to the network untouched.

const CACHE_NAME = 'fondly-shell-v1';

const APP_SHELL = [
  'home.html',
  'breakdown.html',
  'plan.html',
  'log-outflow.html',
  'bills.html',
  'debt.html',
  'split.html',
  'coach.html',
  'assistant.html',
  'streaks.html',
  'index.html',
  'signup.html',
  'manifest.json',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
      // Don't fail install if a shell file is missing/renamed later
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET requests for our own static files.
  // Everything else (API calls to the backend, cross-origin requests,
  // non-GET requests) passes straight through to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        const copy = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return networkRes;
      })
      .catch(() => caches.match(req))
  );
});
