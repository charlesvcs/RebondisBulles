/* =========================================================================
   REBONDIS BULLES — SERVICE WORKER
   Cache-first sur les fichiers locaux, mise en cache opportuniste des
   polices. Incrémenter CACHE à chaque livraison force la purge côté client.
   ========================================================================= */

var CACHE = 'bulles-v11';

var FICHIERS = [
  './',
  'index.html',
  'style.css',
  'moteur.js',
  'reseau.js',
  'sons.js',
  'plateau.js',
  'interface.js',
  'solveur.js',
  'manifest.webmanifest',
  'icone.svg',
  'icone-masquable.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(FICHIERS); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (noms) {
      return Promise.all(noms.map(function (n) {
        if (n !== CACHE) return caches.delete(n);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function (enCache) {
      if (enCache) return enCache;

      return fetch(event.request).then(function (reponse) {
        if (reponse && reponse.status === 200) {
          var copie = reponse.clone();
          caches.open(CACHE).then(function (cache) {
            try { cache.put(event.request, copie); } catch (e) {}
          });
        }
        return reponse;
      }).catch(function () {
        if (event.request.mode === 'navigate') return caches.match('index.html');
      });
    })
  );
});
