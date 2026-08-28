// Network-only service worker.
// Purpose: satisfy PWA installability without any caching layer, so users
// always get the latest app the moment it deploys. If the network fails,
// the browser shows its normal offline page.
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(fetch(event.request));
});
