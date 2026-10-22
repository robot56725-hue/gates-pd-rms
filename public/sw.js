'use strict';

// Gates PD RMS service worker.
//
// Scope is deliberately narrow: this only exists so the app meets the
// browser's installability criteria (Add to Home Screen / desktop install)
// and so the app shell itself still loads if an officer briefly loses
// signal. It intentionally does NOT cache anything under /api/ -- citation,
// incident, and court data must always come from the network. Serving a
// stale cached API response for law-enforcement records would be worse
// than no offline support at all, so GET /api/* requests, and every
// non-GET request, are left completely untouched (the fetch handler below
// just returns without calling respondWith for those, so the browser
// handles them exactly as if this service worker didn't exist).
//
// Bump CACHE_NAME any time one of the SHELL_ASSETS files changes in a way
// that matters offline -- activate() deletes every previously-cached
// version that doesn't match the current name.
const CACHE_NAME = 'gates-pd-rms-shell-v1';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/assets/gates-pd-logo.jpg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever intercept our own GETs -- never touch POST/PATCH/DELETE
  // (citation/incident writes), and never touch another origin (the
  // zxing-browser CDN script the DL scanner loads), so this service worker
  // cannot accidentally serve a stale write response or interfere with a
  // cross-origin resource.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  const url = new URL(request.url);

  // Never cache API calls -- always go straight to the network so every
  // record view/search/submission reflects the live database.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Full-page navigations (e.g. opening the installed app, or a hard
  // refresh): try the network first so officers get the latest deployed
  // build whenever they have signal, falling back to the cached shell only
  // when the network request fails outright (offline).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static shell assets (CSS/JS/icons/manifest/logo): serve from cache
  // immediately for speed, while refreshing the cache in the background so
  // the next load picks up a new deploy without waiting on it.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
