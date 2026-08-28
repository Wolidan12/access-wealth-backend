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

/* ---------------------------------------------------------------
 * Web Push: payloads arrive as JSON { title, body, url } from the
 * Access Wealth HQ backend (deposit approved, withdrawal paid, plan
 * activated/upgraded, broadcast alerts).
 * ------------------------------------------------------------- */
self.addEventListener('push', (event) => {
    let data = { title: 'Access Wealth HQ', body: '', url: '/#/dashboard' };
    if (event.data) {
        try {
            const parsed = event.data.json();
            data = {
                title: parsed.title || data.title,
                body: parsed.body || '',
                url: parsed.url || data.url,
                event: parsed.event || null
            };
        } catch (_) {
            data.body = event.data.text().slice(0, 500);
        }
    }
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/assets/icon-512.png',
            badge: '/assets/icon-512.png',
            tag: data.event || undefined,      // collapse repeat events per kind
            data: { url: data.url }
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const rawUrl = (event.notification.data && event.notification.data.url) || '/';
    // The Android app uses .html routes; the web PWA uses hash routes — map
    // .html targets onto the equivalent hash route for this shell.
    const hashMap = {
        '/dashboard.html': '/#/dashboard',
        '/plans.html': '/#/plans',
        '/announcements.html': '/#/announcements',
        '/deposit.html': '/#/deposit',
        '/withdraw.html': '/#/withdraw'
    };
    const target = hashMap[rawUrl] || rawUrl || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if ('focus' in client) {
                    client.navigate(target).catch(() => {});
                    return client.focus();
                }
            }
            return self.clients.openWindow(target);
        })
    );
});
