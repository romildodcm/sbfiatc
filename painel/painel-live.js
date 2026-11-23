/* ==========================================================================
   /painel — cliente de GET /api/sbfi/live (AirGateway.Api, operação SbfiLive).

   O servidor é a única fonte do painel: ele já entrega as telas prontas
   (chegadas, partidas e sobrevoos), em ordem, com os textos truncados para
   as 128 × 64 LEDs, mais os logos já quantizados. Este módulo só busca,
   valida, segura a última rodada boa e expõe o estado para o painel.js —
   nenhuma regra de negócio do painel mora aqui.

   Contrato (resumo):
     - 200 application/json, SbfiLiveResponse: { generatedAt, windowMinutes,
       stale, staleAgeSeconds, airport, rotation, logos, screens[] }
     - screens[]: { type: "flight" | "empty" | "error", index, ... }
       flight: airlineName, flight, verticalTrend, originText destinationText,
               levelText, model, depText, etaText, distText, positionText,
               airline: { code, iata, name, color, logoKey }, icao
       empty/error: lines[] (3 linhas) + clock (hh:mm:ss UTC)
     - logos: { [key]: { bitmap (base64), format ("rgb565"|"rgb888"),
       width, height, hash, code } } — bitmap é "large" (big-endian), row-major
     - 429 application/problem+json com RateLimit/Retry-After
     - sem dados ao vivo: uma tela 'error'; fonte parada: última resposta com stale=true

   Sem dependência: roda no navegador (window.PainelLive) e no Node (module.exports).
   ========================================================================== */
(function (root) {
  'use strict';

  var DEFAULT_API = 'https://airgateway.iguspotters.com.br';
  var PATH = '/api/sbfi/live';

  /* a resposta tem Cache-Control: public, max-age=10 — buscar mais rápido que
     isso só repete o mesmo documento; mais devagar que ~1 s o painel para no tempo */
  var MIN_INTERVAL_MS = 10000;
  var TIMEOUT_MS = 8000;
  var DEFAULT_PAGE_SECONDS = 30;

  function cleanBase(base) {
    return String(base || DEFAULT_API).replace(/\/+$/, '');
  }

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : (fallback === undefined ? null : fallback);
  }

  /* generatedAt vem documentado como number (epoch), mas a produção devolve
     ISO 8601 ("2026-11-23T12:52:58Z"). Aceita os dois — e segundos, milissegundos. */
  function timeOf(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') {
      if (!isFinite(v) || v <= 0) return 0;
      return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
    }
    var t = Date.parse(String(v));
    if (isFinite(t) && t > 0) return t;
    var n = parseFloat(v);
    return isFinite(n) ? timeOf(n) : 0;
  }

  function linesOf(s) {
    var lines = (s && Array.isArray(s.lines)) ? s.lines : [];
    return [0, 1, 2].map(function (i) { return String(lines[i] == null ? '' : lines[i]); });
  }

  /* ------------------------------------------------------------------ */
  /* RGB565 -> RGB                                                       */
  /* ------------------------------------------------------------------ */

  function base64Bytes(b64) {
    var s = String(b64 || '');
    var bin;
    if (typeof atob === 'function') {
      bin = atob(s);
    } else if (typeof Buffer !== 'undefined') {
      bin = Buffer.from(s, 'base64').toString('binary');
    } else {
      throw new Error('sem decodificador base64');
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 5 bits -> 8 bits normalizado: o bit alto é repetido nos 3 de baixo, então
     0x1F vira 255 (branco cheio) e não 248. */
  function expand5(v) { return (v << 3) | (v >> 2); }
  function expand6(v) { return (v << 2) | (v >> 4); }

  /* DTO do logo -> { width, height, hash, rgba: Uint8Array(w × h × 4) }.
     O bitmap é exibido como veio: aqui só é decodificado, sem ajuste de cor. */
  function decodeLogo(dto) {
    if (!dto || !dto.bitmap) return null;

    var w = Math.max(1, Math.round(num(dto.width, 0) || 0));
    var h = Math.max(1, Math.round(num(dto.height, 0) || 0));
    var format = String(dto.format || 'rgb565').toLowerCase();
    var bytes = base64Bytes(dto.bitmap);
    var bpp = format.indexOf('888') >= 0 ? 4 : 2;

    if (!w || !h) {
      if (!bytes.length || bytes.length % bpp) return null;
      var n = bytes.length / bpp;
      w = Math.round(Math.sqrt(n * 4 / 3)) || 40;
      h = Math.round(n / w) || 1;
    }

    var rgba = new Uint8Array(w * h * 4);
    var px = Math.floor(bytes.length / bpp);
    for (var i = 0; i < px; i++) {
      var r, g, b;
      if (bpp === 4) {
        r = bytes[i * 4]; g = bytes[i * 4 + 1]; b = bytes[i * 4 + 2];
      } else {
        var v = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
        r = expand5((v >> 11) & 0x1f);
        g = expand6((v >> 5) & 0x3f);
        b = expand5(v & 0x1f);
      }
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    return { width: w, height: h, hash: String(dto.hash || ''), rgba: rgba };
  }

  /* ------------------------------------------------------------------ */
  /* Normalização do documento                                           */
  /* ------------------------------------------------------------------ */

  function normalizeScreen(s, i) {
    var type = s && s.type;
    var index = num(s && s.index, i);
    if (index == null) index = i;

    if (type === 'empty' || type === 'error') {
      return {
        type: type,
        index: index,
        reason: s.reason || '',
        lines: linesOf(s),
        clock: String(s.clock || '')
      };
    }

    /* o discriminador é "flight"; qualquer outra coisa comica é tratada como voo
       só se tiver o essencial, senão vira tela vazia (o painel nunca quebra) */
    var flight = s || {};
    return {
      type: 'flight',
      index: index,
      icao: String(flight.icao || ''),
      callsign: flight.callsign == null ? '' : String(flight.callsign),
      flight: normalizeStr(flight.flight || flight.callsign || flight.icao),
      airlineName: normalizeStr(flight.airlineName),
      verticalTrend: flight.verticalTrend || '',
      originText: normalizeStr(flight.originText),
      destinationText: normalizeStr(flight.destinationText),
      levelText: normalizeStr(flight.levelText),
      model: normalizeStr(flight.model),
      depText: normalizeStr(flight.depText),
      etaText: normalizeStr(flight.etaText),
      distText: normalizeStr(flight.distText),
      positionText: flight.positionText ? normalizeStr(flight.positionText) : '',
      badgeText: normalizeStr(flight.badgeText),
      status: String(flight.status || ''),
      airline: flight.airline || null,
      originSource: String(flight.originSource || ''),
      destinationSource: String(flight.destinationSource || ''),
      depAt: flight.depAt == null ? null : timeOf(flight.depAt),
      etaAt: flight.etaAt == null ? null : timeOf(flight.etaAt),
      distanceKm: num(flight.distanceKm, null),
      altitudeFt: num(flight.altitudeFt, null)
    };
  }

  function normalizeStr(v) {
    return v == null ? '' : String(v);
  }

  function normalizeLogoDto(dto) {
    return {
      code: normalizeStr(dto.code),
      format: normalizeStr(dto.format || 'rgb565'),
      hash: normalizeStr(dto.hash),
      width: num(dto.width, 0),
      height: num(dto.height, 0),
      bitmap: normalizeStr(dto.bitmap)
    };
  }

  function normalize(doc, receivedAt) {
    if (!doc || !Array.isArray(doc.screens)) {
      throw new Error('resposta sem screens');
    }

    var screens = doc.screens.map(normalizeScreen);
    var rotation = doc.rotation || {};
    var logos = {};

    Object.keys(doc.logos || {}).forEach(function (key) {
      var dto = doc.logos[key];
      if (dto && dto.bitmap) logos[key] = normalizeLogoDto(dto);
    });

    var pageSeconds = num(rotation.pageSeconds, DEFAULT_PAGE_SECONDS) || DEFAULT_PAGE_SECONDS;

    return {
      generatedAt: timeOf(doc.generatedAt),
      receivedAt: receivedAt || Date.now(),
      windowMinutes: num(doc.windowMinutes, 10),
      stale: doc.stale === true,
      staleAgeSeconds: num(doc.staleAgeSeconds, 0) || 0,
      airport: doc.airport || null,
      rotation: { pageSeconds: pageSeconds, count: num(rotation.count, screens.length) },
      logos: logos,
      screens: screens
    };
  }

  /* ------------------------------------------------------------------ */
  /* Cliente                                                             */
  /* ------------------------------------------------------------------ */

  function createClient(opts) {
    opts = opts || {};

    var base = cleanBase(opts.apiBase);
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    var now = opts.now || function () { return Date.now(); };
    var timer = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = opts.clearTimeout || function (id) { clearTimeout(id); };
    if (opts.intervalMs) MIN_INTERVAL_MS = opts.intervalMs;

    var logoCache = {};          // hash -> decoded
    var logoCount = 0;

    var st = {
      apiBase: base,
      url: base + PATH,
      /* loadState: 'boot' (nunca carregou) | 'ok' | 'error' */
      phase: 'boot',
      live: null,                // última SbfiLiveResponse normalizada (boa ou stale)
      lastFetchAt: 0,
      nextFetchAt: 0,
      inflight: null,
      error: '',                 // mensagem legível da última falha
      errorKind: '',             // 'net' | 'http' | 'rate' | 'server' | 'parse'
      status: 0,                 // HTTP da última resposta (0 = sem resposta)
      retryAfterMs: 0
    };

    function notify() {
      /* o painel redesenha sozinho a cada 1 s; aqui só acordamos a tela de
         Informações quando está aberta */
      if (typeof opts.onUpdate === 'function') {
        try { opts.onUpdate(st); } catch (e) { }
      }
    }

    /* logo decodificado (cache por hash): o painel só faz putImageData */
    function logoFor(key) {
      var dto = st.live && st.live.logos && st.live.logos[key];
      if (!dto) return null;
      var cacheKey = dto.hash || key;
      if (logoCache[cacheKey]) return logoCache[cacheKey];
      /* 4 logos × ~27 KB; o cache por hash cobre troca de companhia na rodada */
      if (logoCount >= 16) { logoCache = {}; logoCount = 0; }
      var decoded;
      try {
        decoded = decodeLogo(dto);
      } catch (e) {
        decoded = null;
      }
      if (decoded) { logoCache[cacheKey] = decoded; logoCount += 1; }
      return decoded;
    }

    function apply(doc, receivedAt) {
      var live = normalize(doc, receivedAt);
      st.live = live;
      st.phase = 'ok';
      st.error = '';
      st.errorKind = '';
      st.status = 200;
      st.retryAfterMs = 0;
    }

    function fail(kind, message, status, retryAfterMs) {
      st.errorKind = kind;
      st.error = message;
      st.status = status || 0;
      st.retryAfterMs = retryAfterMs || 0;
      /* nunca apaga a última rodada boa: é o que a fonte parada quer dizer */
      if (!st.live) st.phase = 'error';
      notify();
    }

    function parseRetryAfter(res, header) {
      var v = header != null ? header : (res && res.headers && res.headers.get
        ? res.headers.get('Retry-After') : null);
      if (v == null || v === '') return 0;
      var n = parseFloat(v);
      if (isFinite(n)) return Math.max(0, Math.round(n * 1000));
      var t = Date.parse(v);
      return isFinite(t) ? Math.max(0, t - now()) : 0;
    }

    function promiseOf(value, res) {
      if (value && typeof value.then === 'function') return value;
      return Promise.resolve({
        ok: res && res.ok != null ? res.ok : true,
        status: res && res.status != null ? res.status : 200,
        headers: res && res.headers,
        text: function () {
          return Promise.resolve(typeof value === 'string' ? value : JSON.stringify(value));
        }
      });
    }

    function request() {
      var ac = typeof AbortController === 'function' ? new AbortController() : null;
      var fired = false;
      var timeout = timer(function () {
        fired = true;
        if (ac) ac.abort();
      }, TIMEOUT_MS);

      var init = {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: ac ? ac.signal : undefined
      };

      var p;
      try {
        p = doFetch(st.url, init);
      } catch (e) {
        p = Promise.reject(e);
      }

      return promiseOf(p).then(function (res) {
        var status = res.status;
        if (status === 200) {
          return res.text().then(function (body) {
            var doc;
            try {
              doc = JSON.parse(body);
            } catch (e) {
              var pe = new Error('JSON inválido');
              pe.kind = 'parse';
              throw pe;
            }
            apply(doc, now());
            return st;
          });
        }
        if (status === 429) {
          var ra = parseRetryAfter(res);
          fail('rate', 'Muitas tentativas (429)', status, ra);
          return st;
        }
        if (status >= 500) {
          fail('server', 'Fonte fora do ar (HTTP ' + status + ')', status,
            parseRetryAfter(res));
          return st;
        }
        fail('http', 'Resposta HTTP ' + status, status, parseRetryAfter(res));
        return st;
      }, function (err) {
        var aborted = fired || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
        fail('net', aborted ? 'Tempo esgotado' : 'Sem resposta da API', 0, 0);
        return st;
      }).then(function (result) {
        clearTimer(timeout);
        return result;
      }, function (err) {
        clearTimer(timeout);
        fail('parse', (err && err.message) || 'Falha ao ler a resposta', 0, 0);
        return st;
      });
    }

    /* Busca a rodada. Nunca rejeita: devolve o estado atualizado; quem chama
       olha st.phase / st.error. Respeita o intervalo mínimo (10 s) e o
       Retry-After do 429. */
    function load(force) {
      var t = now();
      if (st.inflight) return st.inflight;
      if (!force && t < st.nextFetchAt) return Promise.resolve(st);

      st.inflight = request().then(function (result) {
        st.inflight = null;
        st.lastFetchAt = now();
        var ms = MIN_INTERVAL_MS;
        if (st.retryAfterMs) ms = Math.max(ms, st.retryAfterMs);
        st.nextFetchAt = st.lastFetchAt + ms;
        notify();
        return result;
      }, function (err) {
        st.inflight = null;
        fail('parse', (err && err.message) || 'Falha ao carregar', 0, 0);
        st.lastFetchAt = now();
        st.nextFetchAt = st.lastFetchAt + Math.max(MIN_INTERVAL_MS * 3, 30000);
        return st;
      });

      return st.inflight;
    }

    /* tela atual da rodada (ou null): o painel mantém o voo quando a rodada muda
       através de findScreen(icao) */
    function screen(offset) {
      var screens = st.live ? st.live.screens : [];
      if (!screens.length) return null;
      var i = ((offset | 0) % screens.length + screens.length) % screens.length;
      return screens[i];
    }

    function findScreen(match) {
      var screens = st.live ? st.live.screens : [];
      if (!match) return -1;
      for (var i = 0; i < screens.length; i++) {
        var s = screens[i];
        if (s.type !== 'flight') continue;
        if ((match.icao && s.icao === match.icao) ||
            (match.callsign && s.callsign === match.callsign)) return i;
      }
      return -1;
    }

    function reset() {
      st.phase = 'boot';
      st.live = null;
      st.error = '';
      st.errorKind = '';
      st.status = 0;
      st.lastFetchAt = 0;
      st.nextFetchAt = 0;
      st.retryAfterMs = 0;
      logoCache = {};
      logoCount = 0;
      notify();
    }

    return {
      load: load,
      logoFor: logoFor,
      screen: screen,
      findScreen: findScreen,
      reset: reset,
      getState: function () { return st; },
      /* exposto para o teste de contrato (sem instanciar cliente) */
      _normalize: normalize,
      _decodeLogo: decodeLogo
    };
  }

  var api = {
    DEFAULT_API: DEFAULT_API,
    PATH: PATH,
    MIN_INTERVAL_MS: MIN_INTERVAL_MS,
    createClient: createClient,
    normalize: normalize,
    decodeLogo: decodeLogo,
    timeOf: timeOf
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PainelLive = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
