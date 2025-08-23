// Service Worker para controle de cache - Versão Anti-Cache para Streams
const CACHE_NAME = 'sbfi-atc-v1';
const STREAM_URL = 'https://ic.io.tec.br/sbfi';

// Recursos que podem ser cacheados (estáticos)
const STATIC_RESOURCES = [
  '/',
  '/index.html',
  '/styles.css',
  '/script.js'
];

// Instalação do Service Worker
self.addEventListener('install', (event) => {
  console.log('Service Worker: Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Cache aberto');
        return cache.addAll(STATIC_RESOURCES);
      })
  );
});

// Interceptar requests
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  
  // Para streams de áudio: NUNCA usar cache
  if (url.includes(STREAM_URL) || url.includes('ic.io.tec.br')) {
    console.log('Service Worker: Stream detectado, evitando cache:', url);
    event.respondWith(
      fetch(event.request, {
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      })
    );
    return;
  }
  
  // Para outros recursos: usar estratégia cache-first para arquivos estáticos
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Retorna do cache se encontrado, senão busca na rede
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});

// Ativação do Service Worker
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Ativando...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Removendo cache antigo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
