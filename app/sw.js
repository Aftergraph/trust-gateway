/* Trust Gateway v2 — service worker (W9)
   Cache-first app shell; network-only for the gateway API; offline fallback. */
'use strict';

/* Bump this constant to invalidate every cache on deploy. */
const VERSION = 'trust-gateway-v2-pwa-w9.1.0';
const SHELL_CACHE = 'tg-shell-' + VERSION;

/* The app shell: everything needed to render the console with no network. */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/keys.js',
  '/compose.js',
  '/style.css',
  '/responsive.css',
  '/desktop.css',
  '/offline.html',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('tg-shell-') && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache mutations
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: leave alone

  /* Gateway API (/v1/, /v2/) is always network-only — never serve stale
     audit, approval, or SSE data from cache. */
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) {
    event.respondWith(fetch(req));
    return;
  }

  /* Navigations: cache-first shell, fall back to the network, then offline.html. */
  if (req.mode === 'navigate') {
    event.respondWith(
      caches
        .match('/index.html')
        .then((hit) => hit || fetch(req))
        .catch(() => caches.match('/offline.html'))
    );
    return;
  }

  /* Everything else (shell assets): cache-first, network fallback. */
  event.respondWith(
    caches
      .match(req)
      .then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
      )
      .catch(() => caches.match('/offline.html'))
  );
});