const CACHE_NAME = 'labani-pwa-v16';
const APP_SHELL = [
  './',
  './index.html',
  './terms.html',
  './privacy.html',
  './manifest.webmanifest',
  './Logo%20%26%20Fav%20Icon.png',
  './assets/trampoline-foam-pit-group%20Large.jpeg',
  './assets/trampoline-flip-foam-pit%20Large.jpeg',
  './assets/foam-pit-party-group%20Large.jpeg',
  './assets/indoor-obstacle-play-area%20Large.jpeg',
  './assets/resort-courtyard-party%20Large.jpeg',
  './assets/red-lit-nightclub-vip-lounge%20Large.jpeg',
  './assets/pool-party-resort%20Large.jpeg',
  './assets/trampoline-fitness-class%20Large.jpeg',
  './assets/kintik-mirror-club-interior%20Large.jpeg',
  './assets/restaurant-lounge-dining%20Large.jpeg',
  './assets/checkerboard-walkway-party-crowd%20Large.jpeg',
  './assets/outdoor-patio-restaurant-crowd%20Large.jpeg',
  './assets/evening-labani-concert-stage%20Large.jpeg',
  './assets/kintik-suya-grill-rotisserie%20Large.jpeg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const shouldPreferNetwork =
    event.request.mode === 'navigate' ||
    (isSameOrigin && ['document', 'script', 'style'].includes(event.request.destination));

  if (shouldPreferNetwork) {
    event.respondWith(
      fetch(event.request).then(response => {
        const copy = response.clone();
        if (response.ok && isSameOrigin) {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        const copy = response.clone();
        if (response.ok && isSameOrigin) {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return cached;
      });
    })
  );
});
