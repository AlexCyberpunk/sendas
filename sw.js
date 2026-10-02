const SHELL = 'shell-v9';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/geo.js',
  'js/layers.js',
  'js/offline.js',
  'js/tracker.js',
  'js/ui.js',
  'js/dem.js',
  'js/slope.js',
  'js/routefollow.js',
  'js/sun.js',
  'js/sos.js',
  'js/planner.js',
  'js/weather.js',
  'js/photos.js',
  'js/view3d.js',
  'js/peaks.js',
  'js/panorama.js',
  'js/shareimg.js',
  'js/exif.js',
  'js/voice.js',
  'js/simulate.js',
  'js/lock.js',
  'data/peaks-es.json',
  'vendor/suncalc/suncalc.js',
  'vendor/maplibre/maplibre-gl.js',
  'vendor/maplibre/maplibre-gl.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const TILE_HOSTS = ['ign.es', 'opentopomap.org', 'openstreetmap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const isDem = url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/');
  if (isDem || TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    // Downloaded zones live in per-zone caches; caches.match searches all of them.
    event.respondWith((async () => {
      const hit = await caches.match(req.url);
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => hit || Response.error());
      if (hit) { event.waitUntil(net); return hit; }
      return net;
    })());
  }
});
