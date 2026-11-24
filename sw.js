// Service Worker para controle de cache - Versão Anti-Cache para Streams
const CACHE_NAME = 'sbfi-atc-v23';
const STREAM_URL = 'https://ic.io.tec.br/sbfi';

// Recursos locais estáticos
const STATIC_RESOURCES = [
  '/',
  '/index.html',
  // Painel oculto de chegadas/partidas (GET /api/sbfi/live) — só por link direto, sem link no site
  '/painel/',
  '/painel/index.html',
  '/painel/painel.css',
  '/painel/painel.js',
  '/painel/painel-live.js',
  // Canal secundário (mount sbfi2) — não é linkado no site, só acesso direto
  '/secundary/',
  '/radio-analytics.js',
  '/radio-recorder.js',
  '/radio-waveform.js',
  // Impede a tela de apagar (TV / Fire Stick): script + vídeo mudo em loop.
  // Fica no cache para o vídeo existir mesmo offline — sem ele, o navegador
  // da TV volta a deixar a tela dormir.
  '/keep-awake.js',
  '/keep-awake.mp4',
  '/keep-awake-mute.mp4',
  '/keep-awake-loop.mp4',
  '/favicon/android-chrome-512x512.png',
  '/favicon/apple-touch-icon.png',
  '/favicon/favicon-32x32.png',
  '/favicon/favicon-16x16.png',
  '/favicon/favicon.ico',
  '/favicon/site.webmanifest',
];

// CDNs estáticos que podem ser cacheados
const CDN_CACHE_ORIGINS = [
  'https://fonts.googleapis.com/',
  'https://fonts.gstatic.com/',
];

// URLs que NUNCA devem ser cacheadas
function isNoCacheUrl(url) {
  return url.includes('ic.io.tec.br') ||
         url.includes('opensky-network.org') ||
         url.includes('/api/') ||
         url.includes('localhost') ||
         url.includes('127.0.0.1') ||
         url.includes('googletagmanager.com') ||
         url.includes('google-analytics.com');
}

function isCdnUrl(url) {
  return CDN_CACHE_ORIGINS.some(origin => url.startsWith(origin));
}

// Código do site: sempre da rede primeiro, para a atualização valer na hora
function isCodeUrl(request) {
  if (request.destination === 'document') return true;
  const path = new URL(request.url).pathname;
  return /\.(js|css|html)$/i.test(path) || /\/$/.test(path);
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

  // Código (HTML, JS, CSS): rede primeiro. O stale-while-revalidate antigo
  // servia a versão anterior do painel.js a cada carga — a correção só
  // aparecia no navegador depois de duas visitas com o SW atualizado.
  // A cópia em cache fica só como reserva quando não há rede.
  if (isCodeUrl(event.request)) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Demais recursos locais: stale-while-revalidate, para funcionar offline
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

// O keep-awake.js troca o <source> do vídeo quando o navegador recusa a
// variante anterior. Responde usando a MESMA URL (sem redirecionar) e sempre
// com o Content-Type de MP4: navegador antigo recusa o vídeo quando a resposta
// chega como text/html ou octet-stream (caso do Pages sem MIME configurado).
const KEEP_AWAKE_VIDEO = /\/keep-awake(?:-[a-z]+)?\.mp4$/;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const pathname = new URL(request.url).pathname;
  if (request.method !== 'GET' || !KEEP_AWAKE_VIDEO.test(pathname)) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true })
      .then((cached) => cached || fetch(request))
      .then((response) => {
        if (!response || !response.ok) return response;
        return new Response(response.body, {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-cache' },
        });
      })
  );
});
