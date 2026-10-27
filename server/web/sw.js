// Minimal service worker so the web app is installable (and appears in the
// Android share sheet). It does no caching: every request goes to the network,
// so the app never shows stale data.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only */ });
