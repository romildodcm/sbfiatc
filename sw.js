// Service Worker para controle de cache - Versão Anti-Cache para Streams
const CACHE_NAME = 'sbfi-atc-v2';
const STREAM_URL = 'https://ic.io.tec.br/sbfi';

// Recursos locais estáticos
const STATIC_RESOURCES = [
  '/',
  '/index.html',
  '/map.html',
  '/styles.css',
  '/script.js',
  '/sbfi/apple-touch-icon.png',
  '/sbfi/favicon-32x32.png',
  '/sbfi/favicon-16x16.png',
  '/sbfi/site.webmanifest',
];

// CDNs estáticos que podem ser cacheados
const CDN_CACHE_ORIGINS = [
  'https://unpkg.com/',
  'https://cdn.jsdelivr.net/',
  'https://fonts.googleapis.com/',
  'https://fonts.gstatic.com/',
];

// URLs que NUNCA devem ser cacheadas
function isNoCacheUrl(url) {
  return url.includes('ic.io.tec.br') ||
         url.includes('/aircraft') ||
         url.includes('googletagmanager.com') ||
         url.includes('google-analytics.com');
}

function isCdnUrl(url) {
  return CDN_CACHE_ORIGINS.some(origin => url.startsWith(origin));
}

// Instalação do Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_RESOURCES))
      .then(() => self.skipWaiting())
  );
});

// Interceptar requests
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Streams de áudio e API: NUNCA usar cache
  if (isNoCacheUrl(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // CDNs estáticos: cache-first, busca na rede se não encontrar
  if (isCdnUrl(url)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Recursos locais: stale-while-revalidate (retorna cache, atualiza em background)
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Ativação do Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});
