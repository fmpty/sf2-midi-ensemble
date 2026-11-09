/** 仅缓存壳资源；内置 SF2 体积大，不预缓存，走网络 */
const CACHE = 'sf2-ensemble-shell-v1';
const PRECACHE = ['./', './index.html', './styles.css', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
        ).then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    const path = url.pathname;
    if (/\.(sf2|sf3|dls|sfogg)$/i.test(path)) return;
    if (path.startsWith('/assets/soundfonts/')) return;

    event.respondWith(
        caches.match(req).then((cached) => {
            const net = fetch(req).then((res) => {
                if (res.ok && (path.endsWith('.js') || path.endsWith('.css') || path === '/' || path.endsWith('.html'))) {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                }
                return res;
            });
            return cached || net;
        }),
    );
});
