/* ==========================================================================
   /painel — painel de LED físico de 320 × 160 mm (P2.5 = 128 × 64 LEDs RGB).

   A página é preta; no meio dela fica o painel. Tudo é desenhado num buffer
   de 128 × 64 pixels (1 pixel = 1 LED), com fonte própria de 5 × 7 para o
   texto sair realmente em matriz de pontos. As telas se alternam:

     CHEGADAS (páginas de 5 voos) -> PARTIDAS (idem) -> DESTAQUE (o próximo
     voo, no layout do painel da foto: logo, companhia, voo, rota, modelo,
     DEP/ETA e km até o destino).

   Fontes de dados:
   - posição/velocidade/altitude: OpenSky (/states/all) — não tem rota.
   - rota, companhia e modelo: ADSBDB (/callsign, /aircraft), com cache local.
   - logo: /airlines/{ICAO}.png do AirGateway.Api; sem arquivo, CDN por IATA;
     sem nenhum dos dois, sigla em caixa de 30 × 27 LEDs.

   Página secundária e oculta: não é linkada em lugar nenhum do site.

   Ajuste visual sem API nem login: /painel/?demo=<cenário> congela o painel
   num cenário de dados falsos (arrival, departure, overflight, unknown, multi,
   empty, err-login, err-auth, err-net). A barra inferior troca de cenário e as
   setas ← → trocam de tela. Sem o parâmetro, o modo demo não executa.
   ========================================================================== */
(function () {
  'use strict';

  /* Se o HTML veio do cache antigo do service worker e o JS é novo, os ids
     não batem. Nesse caso recarrega uma vez furando o cache. */
  if (!document.getElementById('led') || !document.getElementById('glow')) {
    try {
      if (!sessionStorage.getItem('painelReload')) {
        sessionStorage.setItem('painelReload', '1');
        location.replace(location.pathname + '?v=' + Date.now());
      }
    } catch (e) { }
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Painel                                                              */
  /* ------------------------------------------------------------------ */

  var W = 128, H = 64;              // 320 × 160 mm em P2.5
  var PAGE_MS = 30000;              // cada voo fica 30 s na tela
  var LOGO_W = 30, LOGO_H = 27;     // logo, em LEDs

  /* ------------------------------------------------------------------ */
  /* Constantes de dados                                                 */
  /* ------------------------------------------------------------------ */

  var DEFAULT_API = 'http://localhost:5164';   // AirGateway.Api

  var ROUTE_API = 'https://api.adsbdb.com/v0';
  var LOGO_LOCAL = '/airlines/';               // AirGateway.Api (wwwroot/airlines)
  var LOGO_API = 'https://pics.avs.io/200/200/';
  var ROUTE_TTL = 24 * 60 * 60 * 1000;
  var AC_TTL = 7 * 24 * 60 * 60 * 1000;
  var CACHE_CAP = 400;
  var ENRICH_PER_CYCLE = 4;
  var ENRICH_SESSION_CAP = 120;

  /* cobertura do painel: os três aeroportos da tríplice fronteira
     (só nas telas sem voo; a tela de voo usa o rodapé para fuso e rodada) */
  var AREA_LABEL = 'IGU / IGR / AGT';

  var AIRLINES = {
    GLO: { name: 'GOL', iata: 'G3' },
    TAM: { name: 'LATAM', iata: 'LA' },
    LTG: { name: 'LATAM', iata: 'LA' },
    AZU: { name: 'AZUL', iata: 'AD' },
    PTB: { name: 'VOEPASS', iata: '2Z' },
    ONE: { name: 'VOEPASS', iata: '2Z' },
    ARG: { name: 'AEROLINEAS', iata: 'AR' },
    FBZ: { name: 'FLYBONDI', iata: 'FO' },
    JSM: { name: 'JETSMART', iata: 'JA' }
  };

  /* ------------------------------------------------------------------ */
  /* Fonte 5 × 7                                                         */
  /* ------------------------------------------------------------------ */

  var FONT = {
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
    '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
    '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
    '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
    '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    "'": ['00100', '00100', '00000', '00000', '00000', '00000', '00000'],
    '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
    ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
    '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
    '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
    '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
    '°': ['01100', '10010', '10010', '01100', '00000', '00000', '00000'],
    '·': ['00000', '00000', '00000', '01100', '01100', '00000', '00000']
  };

  var GLYPHS = {};
  Object.keys(FONT).forEach(function (ch) {
    var rows = FONT[ch];
    var m = [];
    for (var y = 0; y < 7; y++) {
      var bits = [];
      for (var x = 0; x < 5; x++) bits.push(rows[y].charAt(x) === '1');
      m.push(bits);
    }
    GLYPHS[ch] = m;
  });

  /* cores dos LEDs (RGB) */
  var C = {
    off: [7, 7, 8],
    cyan: [0, 180, 255],
    amber: [255, 148, 20],
    white: [255, 246, 232],
    green: [60, 255, 120],
    red: [255, 70, 50],
    dim: [60, 44, 18],
    dimText: [120, 100, 70]
  };

  /* ------------------------------------------------------------------ */
  /* Elementos                                                           */
  /* ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  var DEBUG = /[?&]debug=1/.test(location.search);
  function log() {
    if (!DEBUG) return;
    try {
      console.log.apply(console, ['[painel]'].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { }
  }

  var el = {
    led: $('led'), glow: $('glow'), panel: $('panel'), boot: $('boot'),
    btnCfg: $('btnCfg'), cfg: $('cfg'), cfgForm: $('cfgForm'),
    cfgStatus: $('cfgStatus'), alertBox: $('alertBox'),
    apiBase: $('apiBase'), email: $('email'), password: $('password'),
    btnClearKey: $('btnClearKey'),
    btnCloseCfg: $('btnCloseCfg'),
    playBtn: $('playBtn'), player: $('radioPlayer'), btnFull: $('btnFull'),
    dockStatus: $('dockStatus'), recordLabel: $('recordLabel'), recordCounter: $('recordCounter')
  };

  var ledCtx = el.led.getContext('2d');
  var glowCtx = el.glow.getContext('2d');
  var frame = ledCtx.createImageData(W, H);
  var data = frame.data;

  for (var _i = 3; _i < data.length; _i += 4) data[_i] = 255;   // alpha fixo

  /* ------------------------------------------------------------------ */
  /* Estado                                                              */
  /* ------------------------------------------------------------------ */

  var state = {
    /* centro fixo: SBFI (aeroporto de Foz do Iguaçu) */
    lat: -25.593485,
    lon: -54.490306,
    interval: 60,

    apiBase: DEFAULT_API,
    email: '',
    password: '',
    token: '',
    tokenExpiresAt: 0,
    loginPending: null,
    airportsPending: null,
    airportId: null,          // usado quando o usuário não tem aeroporto (admin)
    user: null,
    airport: null,

    centerName: 'SBFI',

    aircraft: [],
    depSeen: new Map(),
    routes: {},
    acinfo: {},
    extraQueries: 0,
    adsbOff: false,

    lastFetchAt: 0,
    nextFetchAt: 0,
    inflight: false,
    error: '',

    screens: [],
    screenIndex: 0,
    lastPageAt: 0,
    logoCache: {},

    demo: ''                 // cenário de /painel/?demo=..., ver bloco "Modo demo"
  };

  /* ------------------------------------------------------------------ */
  /* Desenho                                                             */
  /* ------------------------------------------------------------------ */

  function px(x, y, c) {
    x = x | 0; y = y | 0;
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    var i = (y * W + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
  }

  function clear() {
    for (var i = 0; i < data.length; i += 4) {
      data[i] = C.off[0];
      data[i + 1] = C.off[1];
      data[i + 2] = C.off[2];
    }
  }

  function rect(x, y, w, h, c) {
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) px(x + i, y + j, c);
    }
  }

  /* avanco por caractere: o glifo ocupa 5 colunas + 1 de respiro. O espaco
     tem glifo vazio, entao avanca menos — 4 colunas em vez de 6 — e a
     distancia entre palavras dobra de valor util sem inventar kerning. */
  function advanceOf(ch) { return ch === ' ' ? 4 : 6; }

  function text(x, y, str, c, scale) {
    scale = scale || 1;
    var s = normalizeText(str);
    var cx = x;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var g = GLYPHS[ch] || GLYPHS['?'];
      for (var row = 0; row < 7; row++) {
        for (var col = 0; col < 5; col++) {
          if (!g[row][col]) continue;
          rect(cx + col * scale, y + row * scale, scale, scale, c);
        }
      }
      cx += advanceOf(ch) * scale;
    }
    return cx - x - scale;
  }

  function textWidth(str, scale) {
    scale = scale || 1;
    var s = String(str);
    var w = 0;
    for (var i = 0; i < s.length; i++) w += advanceOf(s.charAt(i));
    return w * scale - scale;
  }

  function textRight(xEnd, y, str, c, scale) {
    text(xEnd - textWidth(normalizeText(str), scale) - 1, y, str, c, scale);
  }

  function textCenter(y, str, c, scale) {
    var s = normalizeText(str);
    text(Math.max(0, Math.round((W - textWidth(s, scale)) / 2)), y, s, c, scale);
  }

  /* acentos não existem na matriz 5 × 7: viram a letra base */
  function normalizeText(str) {
    var s = String(str == null ? '' : str);
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.toUpperCase();
  }

  function truncate(str, n) {
    var s = normalizeText(str);
    return s.length > n ? s.slice(0, n) : s;
  }

  function flush() {
    ledCtx.putImageData(frame, 0, 0);
    glowCtx.putImageData(frame, 0, 0);
    if (el.boot && !el.boot.hidden) el.boot.hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* Dados                                                               */
  /* ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* horários sempre em UTC (o painel é operacional) */
  function hhmm(d) { return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }
  function hhmmss(d) {
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  var RAD = Math.PI / 180;

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371.0088;
    var dLat = (lat2 - lat1) * RAD;
    var dLon = (lon2 - lon1) * RAD;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function fmtDist(km) {
    if (km == null || !isFinite(km)) return '—';
    return km < 10 ? km.toFixed(1) : String(Math.round(km));
  }

  function fmtAltFt(a) {
    if (a.onGround) return 'SOLO';
    if (a.alt == null) return '—';
    var ft = a.alt * 3.28084;
    if (ft < 1000) return String(Math.round(ft / 10) * 10);
    return String(Math.round(ft / 100) * 100);
  }

  function fmtKm(km) {
    if (km == null || !isFinite(km)) return '—';
    return Math.round(km).toLocaleString('pt-BR');
  }

  function hueFromString(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function hsl(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var hue2rgb = function (p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  /* ------------------------------------------------------------------ */
  /* AirGateway API (login JWT + aeronaves ao vivo)                      */
  /* ------------------------------------------------------------------ */

  function apiUrl(path) {
    return String(state.apiBase || DEFAULT_API).replace(/\/+$/, '') + path;
  }

  /* e-mail/senha → access token (30 min); renova sozinho quando expira */
  function login() {
    if (!state.email || !state.password) {
      var sem = new Error('sem credenciais');
      sem.code = 'nocreds';
      return Promise.reject(sem);
    }
    if (state.token && Date.now() < state.tokenExpiresAt - 60000) {
      return Promise.resolve(state.token);
    }
    if (state.loginPending) return state.loginPending;

    log('LOGIN', state.email, '→', apiUrl('/api/auth/login'));

    state.loginPending = fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: state.email, password: state.password })
    }).then(function (r) {
      if (r.status === 401) {
        var e1 = new Error('e-mail ou senha inválidos');
        e1.code = 'auth';
        throw e1;
      }
      if (!r.ok) {
        var e2 = new Error('login respondeu HTTP ' + r.status);
        e2.code = 'http';
        throw e2;
      }
      return r.json();
    }).then(function (j) {
      state.token = j.accessToken || '';
      state.tokenExpiresAt = Date.now() + (j.expiresIn || 1800) * 1000;
      state.user = j.user || null;
      state.airportId = null;      // recalculado conforme o usuário logado
      log('LOGIN ok', state.user && state.user.email, '· token', (j.expiresIn | 0) + 's');
      return state.token;
    });

    /* limpa o pending tanto no sucesso quanto no erro */
    state.loginPending = state.loginPending.then(function (v) {
      state.loginPending = null;
      return v;
    }, function (err) {
      state.loginPending = null;
      throw err;
    });

    return state.loginPending;
  }

  /* Admin sem aeroporto vinculado: escolhe o primeiro aeroporto ativo e
     manda ?airportId= (a API devolve 400 se ninguém disser o aeroporto). */
  function resolveAirportId() {
    if (state.airportId) return Promise.resolve(state.airportId);
    if (state.airportsPending) return state.airportsPending;

    log('GET', apiUrl('/api/airports'));

    state.airportsPending = fetch(apiUrl('/api/airports'), {
      headers: { Authorization: 'Bearer ' + state.token },
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) return [];
      return r.json();
    }).then(function (list) {
      var ativos = (list || []).filter(function (a) { return a.isActive !== false; });
      state.airportId = ativos.length ? ativos[0].id : null;
      log('aeroporto escolhido:', state.airportId);
      return state.airportId;
    });

    state.airportsPending = state.airportsPending.then(function (v) {
      state.airportsPending = null;
      return v;
    }, function (err) {
      state.airportsPending = null;
      throw err;
    });

    return state.airportsPending;
  }

  /* Se o endereço configurado não responde (API parada ou CORS), tenta a
     mesma origem da página — cobre o caso do proxy de dev e de servir o
     painel pelo mesmo domínio da API. */
  function podeCairParaOrigem() {
    return location.protocol !== 'file:' &&
      location.origin !== state.apiBase &&
      state.apiBase !== location.origin;
  }

  function fetchLive(retry) {
    return executarFetchLive(retry).catch(function (err) {
      if (err && err.name === 'TypeError' && !retry && podeCairParaOrigem()) {
        log('falha de rede/CORS em', state.apiBase, '→ tentando', location.origin);
        state.apiBase = location.origin;
        state.token = '';
        state.airportId = null;
        return executarFetchLive(true);
      }
      throw err;
    });
  }

  function executarFetchLive(retry) {
    return login()
      .then(function () {
        /* a resposta do login diz se o usuário tem aeroporto vinculado */
        return (state.user && !state.user.airport) ? resolveAirportId() : null;
      })
      .then(function () {
        var url = apiUrl('/api/aircraft/live?minutes=10' +
          (state.airportId ? '&airportId=' + state.airportId : ''));

        log('GET', url);

        return fetch(url, {
          headers: { Authorization: 'Bearer ' + state.token },
          cache: 'no-store'
        });
      }).then(function (r) {
      if (r.status === 401 && !retry) {
        state.token = '';
        state.tokenExpiresAt = 0;
        return fetchLive(true);
      }
      if (r.status === 400 && !retry) {
        /* usuário sem vínculo: descobre o aeroporto e tenta de novo */
        return resolveAirportId().then(function (id) {
          if (!id) {
            var semAp = new Error('usuário sem aeroporto vinculado');
            semAp.code = 'airport';
            throw semAp;
          }
          return fetchLive(true);
        });
      }
      if (r.status === 403) {
        var e403 = new Error('sem acesso a este aeroporto');
        e403.code = 'auth';
        throw e403;
      }
      if (!r.ok) {
        var e = new Error('API respondeu HTTP ' + r.status);
        e.code = 'http';
        throw e;
      }
      return r.json();
    });
  }

  /* ------------------------------------------------------------------ */
  /* ADSBDB: rota, companhia e modelo                                    */
  /* ------------------------------------------------------------------ */

  function airportOf(p) {
    if (!p) return null;
    return {
      iata: p.iata_code || '',
      icao: p.icao_code || '',
      city: p.municipality || '',
      name: p.name || '',
      lat: p.latitude == null ? null : p.latitude,
      lon: p.longitude == null ? null : p.longitude
    };
  }

  function fetchRoute(callsign) {
    return fetch(ROUTE_API + '/callsign/' + encodeURIComponent(callsign), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var fr = j && j.response && j.response.flightroute;
        if (!fr) return null;
        return {
          airline: fr.airline ? {
            name: fr.airline.name || '',
            iata: fr.airline.iata || '',
            icao: fr.airline.icao || ''
          } : null,
          origin: airportOf(fr.origin),
          destination: airportOf(fr.destination),
          t: Date.now()
        };
      });
  }

  function fetchAircraft(icao) {
    return fetch(ROUTE_API + '/aircraft/' + encodeURIComponent(icao), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var ac = j && j.response && j.response.aircraft;
        if (!ac) return null;
        return {
          model: ac.type || '',
          manufacturer: ac.manufacturer || '',
          icao_type: ac.icao_type || '',
          t: Date.now()
        };
      });
  }

  function routeOf(a) {
    var r = state.routes[a.callsign];
    return (r && !r.none) ? r : null;
  }

  function acOf(a) {
    var x = state.acinfo[a.icao];
    return (x && !x.none) ? x : null;
  }

  function airlineOf(a) {
    var r = routeOf(a);
    var cs = normalizeText(a.callsign);
    var prefix = cs.slice(0, 3);
    var known = AIRLINES[prefix];
    var name = (r && r.airline && r.airline.name) || (known && known.name) || '';
    var iata = (r && r.airline && r.airline.iata) || (known && known.iata) || '';
    return {
      code: (prefix || a.icao.slice(0, 3)).toUpperCase(),
      iata: String(iata).toUpperCase(),
      name: name || '',
      /* só o prefixo do callsign é ICAO de companhia; sem callsign o "code"
         é só um pedaço do hex da aeronave e não vale pedir logo */
      fromCallsign: !!prefix,
      color: hsl(hueFromString(prefix || a.icao), 65, 45)
    };
  }

  function typeOf(a) {
    var ac = acOf(a);
    if (!ac) return '';
    if (ac.manufacturer && ac.icao_type) return ac.manufacturer + ' ' + ac.icao_type;
    return ac.model || ac.icao_type || '';
  }

  function enrich(list) {
    if (state.adsbOff) return Promise.resolve();
    if (state.extraQueries >= ENRICH_SESSION_CAP) return Promise.resolve();

    var targets = list.filter(function (a) {
      return a.callsign && a.callsign.length >= 4 && a.callsign.indexOf('-') < 0;
    });

    var todo = targets.filter(function (a) {
      return !state.routes[a.callsign] || !state.acinfo[a.icao];
    }).slice(0, ENRICH_PER_CYCLE);

    if (!todo.length) return Promise.resolve();

    var chain = Promise.resolve();
    todo.forEach(function (a) {
      chain = chain.then(function () {
        if (state.extraQueries >= ENRICH_SESSION_CAP) return;
        var tasks = [];

        if (!state.routes[a.callsign]) {
          state.extraQueries += 1;
          tasks.push(fetchRoute(a.callsign).then(function (r) {
            state.routes[a.callsign] = r || { none: true, t: Date.now() };
          }).catch(function () {
            state.routes[a.callsign] = { none: true, t: Date.now() };
            state.adsbOff = true;
          }));
        }

        if (!state.acinfo[a.icao]) {
          tasks.push(fetchAircraft(a.icao).then(function (x) {
            state.acinfo[a.icao] = x || { none: true, t: Date.now() };
          }).catch(function () {
            state.acinfo[a.icao] = { none: true, t: Date.now() };
          }));
        }

        return Promise.all(tasks);
      });
    });

    return chain.then(saveCaches);
  }

  /* ------------------------------------------------------------------ */
  /* Conversão da resposta da API                                        */
  /* ------------------------------------------------------------------ */

  var STATUS_KIND = {
    approaching: 'arr',
    departing: 'dep',
    ground: 'ground',
    overflight: 'over'
  };

  function normalizeLive(json) {
    var airport = json.airport || null;
    if (airport) {
      state.airport = airport;
      state.centerName = airport.icao || state.centerName;
      state.lat = airport.latitude;
      state.lon = airport.longitude;
    }

    var list = json.aircraft || [];

    return list.map(function (x) {
      return {
        icao: String(x.icao24 || '').toLowerCase(),
        callsign: String(x.callsign || '').trim() || String(x.icao24 || '').toUpperCase(),
        country: x.country || '',
        lat: x.latitude,
        lon: x.longitude,
        alt: x.altitudeFt == null ? null : x.altitudeFt / 3.28084,
        onGround: !!x.onGround,
        speed: x.groundSpeedKt == null ? null : x.groundSpeedKt / 1.943844,
        track: x.track,
        vrate: x.verticalRateFpm == null ? null : x.verticalRateFpm / 196.8504,
        d: x.distanceKm,
        kind: STATUS_KIND[x.status] || 'over',
        status: x.status,
        observedAt: x.observedAt
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ciclo de atualização                                                */
  /* ------------------------------------------------------------------ */

  function refresh() {
    if (state.demo) return;
    if (state.inflight) return;
    if (document.hidden) return;

    state.inflight = true;
    state.error = '';

    fetchLive()
      .then(function (json) {
        var now = Date.now();
        state.aircraft = normalizeLive(json);
        state.lastFetchAt = now;
        state.nextFetchAt = now + state.interval * 1000;
        log('aeronaves:', state.aircraft.length, '· aeroporto', state.centerName);
        buildScreens();
        draw();
        return enrich(state.aircraft);
      })
      .then(function () {
        buildScreens();
        draw();
        updateCfgStatus();
      })
      .catch(function (err) {
        var msg;
        var kind = err && err.code;

        if (kind === 'nocreds') {
          msg = 'Configure e-mail e senha da API em Configurações.';
        } else if (kind === 'airport') {
          msg = 'Este usuário não tem aeroporto vinculado — vincule em /api/users ou use um admin.';
        } else if (kind === 'auth') {
          state.token = '';
          state.tokenExpiresAt = 0;
          msg = (err && err.message) || 'Login recusado pela API.';
        } else if (err && err.name === 'TypeError') {
          msg = 'Não consegui falar com ' + state.apiBase +
            ' (API parada? CORS? veja Cors__AllowedOrigins).';
        } else {
          msg = (err && err.message) || 'Falha ao consultar a API.';
        }

        state.errorKind = kind || 'http';
        state.error = msg;
        log('ERRO:', msg);
        setAlert(msg);
        state.nextFetchAt = Date.now() + Math.max(state.interval, 30) * 1000;
        draw();
      })
      .then(function () {
        state.inflight = false;
        updateCfgStatus();
      });
  }

  /* ------------------------------------------------------------------ */
  /* Telas                                                               */
  /* ------------------------------------------------------------------ */

  function clockOf(ms) { return ms ? hhmm(new Date(ms)) : '--:--'; }

  function codeOf(ap) {
    if (!ap) return '-';
    return normalizeText(ap.iata || ap.icao || '-');
  }

  function cardData(a) {
    var route = routeOf(a);
    var center = { iata: state.centerName, icao: state.centerName, lat: state.lat, lon: state.lon };

    var origin = (route && route.origin) || (a.kind === 'dep' ? center : null);
    var destination = (route && route.destination) || (a.kind === 'arr' ? center : null);

    var destHasPos = !!(destination && destination.lat != null && destination.lon != null);
    var kmToGo = null;
    if (destHasPos) kmToGo = haversineKm(a.lat, a.lon, destination.lat, destination.lon);
    else if (a.kind === 'arr') kmToGo = a.d;

    var etaMs = null;
    if (kmToGo != null && a.speed && a.speed > 20) {
      etaMs = Date.now() + (kmToGo / (a.speed / 1000)) * 1000;
    }

    var depMs = null;
    if (a.kind === 'dep' && state.depSeen.has(a.icao)) {
      depMs = state.depSeen.get(a.icao);
    } else if (destHasPos && route && route.origin && route.origin.lat != null &&
               a.speed && a.speed > 40) {
      var legKm = haversineKm(route.origin.lat, route.origin.lon,
        destination.lat, destination.lon);
      var flownKm = legKm - kmToGo;
      if (flownKm > 15) depMs = Date.now() - (flownKm / (a.speed / 1000)) * 1000;
    }

    if (depMs == null && a.kind === 'dep' && a.alt != null &&
        a.vrate != null && a.vrate > 1.5 && a.alt > 300) {
      var climbSec = a.alt / a.vrate;
      if (climbSec < 3600) depMs = Date.now() - climbSec * 1000;
    }

    return {
      a: a,
      icao: a.icao,
      kind: a.kind,
      airline: airlineOf(a),
      flight: normalizeText(a.callsign),
      origin: origin,
      destination: destination,
      model: typeOf(a),
      depMs: depMs,
      etaMs: etaMs,
      kmToGo: kmToGo,
      toDest: destHasPos || a.kind === 'arr'
    };
  }

  function rowsOf(mode) {
    var list = state.aircraft.filter(function (a) { return a.kind === mode; }).map(cardData);
    if (mode === 'arr') {
      list.sort(function (x, y) { return (x.etaMs || Infinity) - (y.etaMs || Infinity); });
    } else {
      list.sort(function (x, y) { return x.a.d - y.a.d; });
    }
    return list;
  }

  /* Ordem da rodada: chegadas (quem pousa antes), partidas (mais perto) e,
     por fim, quem está só passando pela região — assim o painel nunca fica
     vazio num momento sem chegada/partida. */
  function orderedFlights() {
    var arr = rowsOf('arr');
    var dep = rowsOf('dep');
    var usados = {};

    arr.concat(dep).forEach(function (d) { usados[d.icao] = true; });

    var outros = state.aircraft.filter(function (a) { return !usados[a.icao]; })
      .map(cardData)
      .sort(function (x, y) { return x.a.d - y.a.d; });

    return arr.concat(dep, outros);
  }

  /* Uma tela por voo; o painel troca de voo a cada PAGE_MS e recomeça. */
  function buildScreens() {
    var atual = state.screens[state.screenIndex];
    var icaoAtual = (atual && atual.type === 'flight') ? atual.data.icao : null;

    var lista = orderedFlights();
    var out = lista.map(function (d) { return { type: 'flight', data: d }; });
    if (!out.length) out.push({ type: 'empty' });

    state.screens = out;

    /* mantém o voo que está na tela quando os dados são atualizados */
    if (icaoAtual) {
      for (var i = 0; i < out.length; i++) {
        if (out[i].type === 'flight' && out[i].data.icao === icaoAtual) {
          state.screenIndex = i;
          return;
        }
      }
    }
    if (state.screenIndex >= out.length) state.screenIndex = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Logo em LEDs                                                        */
  /* ------------------------------------------------------------------ */

  /* Fontes do logo, na ordem tentada: PNG do AirGateway.Api (nomeado pelo
     ICAO do callsign) e, se não existir, o CDN por IATA. */
  function logoUrls(airline) {
    var urls = [];
    if (airline.fromCallsign && airline.code) {
      urls.push(apiUrl(LOGO_LOCAL + airline.code + '.png'));
    }
    if (airline.iata) urls.push(LOGO_API + airline.iata + '.png');
    return urls;
  }

  /* PNG transparente -> recorte pelo alpha -> 30 x 27 LEDs. Devolve null
     quando não há o que desenhar (imagem vazia, letreiro, canvas sem CORS). */
  function quantizeLogo(img) {
    try {
      /* 1) descobre onde está o desenho dentro do PNG (tem muito vazio) */
      var src = document.createElement('canvas');
      src.width = img.width;
      src.height = img.height;
      var sg = src.getContext('2d');
      sg.drawImage(img, 0, 0);
      var sd = sg.getImageData(0, 0, img.width, img.height).data;

      var minX = img.width, minY = img.height, maxX = -1, maxY = -1;
      for (var y = 0; y < img.height; y++) {
        for (var x = 0; x < img.width; x++) {
          if (sd[(y * img.width + x) * 4 + 3] > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < 0) return null;

      var cw = maxX - minX + 1;
      var ch = maxY - minY + 1;

      /* 2) wordmark (letreiro muito largo) vira sigla: em 30 x 27 LEDs
            um letreiro de 5:1 não lê nada */
      if (cw / ch > 2.2) return null;

      /* 3) desenha o recorte, mantendo a proporção, no bloco de LEDs */
      var c = document.createElement('canvas');
      c.width = LOGO_W;
      c.height = LOGO_H;
      var g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, LOGO_W, LOGO_H);

      var esc = Math.min(LOGO_W / cw, LOGO_H / ch);
      var w = cw * esc, h = ch * esc;
      g.drawImage(img, minX, minY, cw, ch,
        (LOGO_W - w) / 2, (LOGO_H - h) / 2, w, h);

      var d = g.getImageData(0, 0, LOGO_W, LOGO_H).data;
      var px = [];
      for (var i = 0; i < LOGO_W * LOGO_H; i++) {
        var r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
        px.push([Math.min(255, r * 1.35), Math.min(255, gg * 1.35), Math.min(255, b * 1.35)]);
      }

      return px;
    } catch (e) {
      return null;
    }
  }

  /* Pixels do logo já quantizados, ou null enquanto carrega (o redesenho vem
     no onReady). O cache é 1 resultado por companhia: 'loading' enquanto
     tenta, depois { px: [...] } ou { px: null }. */
  function ensureLogo(airline, onReady) {
    var key = (airline.fromCallsign && airline.code) || airline.iata;
    var urls = key ? logoUrls(airline) : [];
    if (!urls.length) return null;

    var cached = state.logoCache[key];
    if (cached && cached !== 'loading') return cached.px;
    if (cached === 'loading') return null;

    state.logoCache[key] = 'loading';

    var next = 0;

    function finish(px) {
      state.logoCache[key] = { px: px };
      onReady();
    }

    /* arquivo inexistente (404) ou inutilizável: tenta a próxima fonte */
    function attempt() {
      if (next >= urls.length) { finish(null); return; }
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        var px = quantizeLogo(img);
        if (px) { finish(px); return; }
        attempt();
      };
      img.onerror = attempt;
      img.src = urls[next];
      next += 1;
    }

    attempt();

    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Desenho das telas                                                   */
  /* ------------------------------------------------------------------ */

  /* Nome da companhia em versão curta: é o que cabe do lado do logo. */
  function airlineName(d) {
    var known = AIRLINES[normalizeText(d.flight).slice(0, 3)];
    if (known) return known.name;

    /* sem companhia (táxi aéreo, aviação geral): mostra o país */
    var n = d.airline.name ? normalizeText(d.airline.name) : normalizeText(d.a.country);
    if (!n) return d.airline.code || '?';
    if (n.length <= 15) return n;
    return n.split(' ')[0];
  }

  /* Nivel de voo: sempre FL, sempre 3 digitos (FL046 em vez de 4600 FT).
     A altitude vem em metros (normalizeLive), por isso a conversao aqui. */
  function levelOf(d) {
    if (d.a.alt == null || d.a.onGround) return '';
    var fl = Math.round(d.a.alt * 3.28084 / 100);
    if (fl < 1) return '';
    return 'FL' + (fl < 100 ? ('00' + fl).slice(-3) : String(fl));
  }

  function kmText(km) {
    if (km == null || !isFinite(km)) return '?';
    return km < 10 ? km.toFixed(1) : String(Math.round(km));
  }

  /* código curto da estação: IATA quando a API informa, senão o ICAO */
  function centerCode() {
    var ap = state.airport;
    return (ap && ap.iata) || state.centerName;
  }

  function distLine(d) {
    if (d.kmToGo != null && d.toDest) return kmText(d.kmToGo) + ' KM TO GO';
    if (d.kind === 'dep') return kmText(d.a.d) + ' KM FROM ORIGIN';
    return kmText(d.a.d) + ' KM FROM ' + truncate(centerCode(), 6);
  }

  /* Layout do painel da foto:
       [logo 30x27] COMPANHIA
                    VOO
                    ────────── linha verde
                    ORG -> DST
       MODELO
       DEP hh:mm              ETA hh:mm
       FALTAM xx KM
       IGU/IGR/AGT            n/m UTC
  */
  function drawFlight(d) {
    var logoPx = ensureLogo(d.airline, function () { draw(); });

    /* o espaço do logo é sempre reservado, para o texto não pular de lugar
       entre um voo e outro */
    if (logoPx) {
      for (var y = 0; y < LOGO_H; y++) {
        for (var x = 0; x < LOGO_W; x++) {
          px(x, y, logoPx[y * LOGO_W + x]);
        }
      }
    } else {
      var col = d.airline.color;
      for (var i = 0; i < LOGO_W; i++) {
        px(i, 0, col); px(i, LOGO_H - 1, col);
      }
      for (var j = 0; j < LOGO_H; j++) {
        px(0, j, col); px(LOGO_W - 1, j, col);
      }
      var sigla = (d.airline.iata || d.airline.code || '?').slice(0, 3);
      text(Math.round((LOGO_W - textWidth(sigla, 1)) / 2), 10, sigla, C.white);
    }

    var tx = LOGO_W + 2;
    var folga = 15;

    text(tx, 0, truncate(airlineName(d), folga), C.white);
    text(tx, 9, truncate(d.flight, folga), C.white);

    /* linha verde dividindo o cabeçalho (companhia + voo) da rota */
    for (var k = tx; k < W; k++) px(k, 17, C.green);

    /* origem/destino desconhecidos aparecem só de um lado da seta */
    var org = d.origin ? codeOf(d.origin) : '';
    var dst = d.destination ? codeOf(d.destination) : '';
    var rota = (org ? org + ' ' : '') + '-> ' + (dst || '?');
    text(tx, 22, truncate(rota, folga), C.cyan);

    text(0, 30, truncate(d.model || 'TYPE ?', 21), C.dimText);
    text(0, 39, 'DEP ' + clockOf(d.depMs), C.amber);
    textRight(W, 39, 'ETA ' + clockOf(d.etaMs), C.white);
    /* distancia a esquerda, nivel de voo a direita (mesma linha) */
    var lvl = levelOf(d);
    text(0, 48, truncate(distLine(d), lvl ? 14 : 21), C.green);
    if (lvl) textRight(W, 48, lvl, C.cyan);

    /* rodapé discreto: fuso e posição na rodada */
    textRight(W, 56, (state.screens.length > 1
      ? (state.screenIndex + 1) + '/' + state.screens.length + ' '
      : '') + 'UTC', C.dimText);
  }

  function drawEmpty() {
    textCenter(12, AREA_LABEL, C.cyan);
    textCenter(26, 'NO FLIGHTS', C.amber);

    /* resposta vazia da API é diferente de "ainda não consultei" */
    textCenter(38, state.lastFetchAt ? 'NO TRAFFIC' : 'STANDBY', C.dimText);
    textCenter(52, hhmmss(new Date()) + ' UTC', C.white);
  }

  function drawError() {
    textCenter(12, AREA_LABEL, C.cyan);

    if (!state.email || !state.password) {
      textCenter(24, 'NO LOGIN', C.red);
      textCenter(36, 'SETTINGS > API', C.amber);
    } else if (state.errorKind === 'auth') {
      textCenter(24, 'AUTH FAILED', C.red);
      textCenter(36, 'SETTINGS > API', C.amber);
    } else {
      textCenter(24, 'NO SIGNAL', C.red);
      textCenter(36, 'API / NET', C.dimText);
    }

    textCenter(52, hhmmss(new Date()) + ' UTC', C.white);
  }

  function draw() {
    clear();

    if (state.error && !state.aircraft.length) {
      drawError();
    } else {
      var s = state.screens[state.screenIndex] || state.screens[0];
      if (s && s.type === 'flight') drawFlight(s.data);
      else drawEmpty();
    }

    flush();
  }

  function nextScreen() {
    if (state.screens.length > 1) {
      state.screenIndex = (state.screenIndex + 1) % state.screens.length;
    }
    state.lastPageAt = Date.now();
    draw();
  }

  /* ------------------------------------------------------------------ */
  /* Relógio / ciclo de telas                                            */
  /* ------------------------------------------------------------------ */

  function tick() {
    if (document.hidden) return;

    if (state.screens.length > 1 && Date.now() - state.lastPageAt > PAGE_MS) {
      state.screenIndex = (state.screenIndex + 1) % state.screens.length;
      state.lastPageAt = Date.now();
    }

    draw();

    /* o rótulo/tempo de gravação vem do /radio-recorder.js */
    if (el.dockStatus) {
      var visivel = !!(el.recordLabel.textContent || el.recordCounter.textContent);
      el.dockStatus.hidden = !visivel;
    }

    if (Date.now() >= state.nextFetchAt) {
      if (!state.demo) refresh();
    } else updateCfgStatus();
  }

  /* ------------------------------------------------------------------ */
  /* Persistência                                                        */
  /* ------------------------------------------------------------------ */

  var LS_KEY = 'sbfiPainelApi';          // { apiBase, email, password }
  var LS_ROUTES = 'sbfiRadarRoutes';
  var LS_AC = 'sbfiRadarAc';
  var STREAM_URL = 'https://ic.io.tec.br/sbfi';

  /* credenciais da API ficam no localStorage deste navegador */
  function loadCreds() {
    try {
      var k = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (!k) return;
      state.apiBase = k.apiBase || DEFAULT_API;
      state.email = k.email || '';
      state.password = k.password || '';
    } catch (e) { }
  }

  function saveCreds(apiBase, email, password) {
    state.apiBase = apiBase || DEFAULT_API;
    state.email = email;
    state.password = password;
    state.token = '';
    state.tokenExpiresAt = 0;
    try {
      if (email || password || apiBase) {
        localStorage.setItem(LS_KEY, JSON.stringify({
          apiBase: state.apiBase, email: email, password: password
        }));
      } else {
        localStorage.removeItem(LS_KEY);
      }
    } catch (e) { }
  }

  function pruneCache(obj, ttlMs) {
    var now = Date.now();
    var keys = Object.keys(obj || {}).sort(function (a, b) {
      return (obj[a].t || 0) - (obj[b].t || 0);
    }).slice(-CACHE_CAP);
    var out = {};
    keys.forEach(function (k) {
      if (now - (obj[k].t || 0) < ttlMs) out[k] = obj[k];
    });
    return out;
  }

  function loadCaches() {
    try { state.routes = pruneCache(JSON.parse(localStorage.getItem(LS_ROUTES) || '{}'), ROUTE_TTL); }
    catch (e) { state.routes = {}; }
    try { state.acinfo = pruneCache(JSON.parse(localStorage.getItem(LS_AC) || '{}'), AC_TTL); }
    catch (e) { state.acinfo = {}; }
  }

  function saveCaches() {
    try {
      state.routes = pruneCache(state.routes, ROUTE_TTL);
      state.acinfo = pruneCache(state.acinfo, AC_TTL);
      localStorage.setItem(LS_ROUTES, JSON.stringify(state.routes));
      localStorage.setItem(LS_AC, JSON.stringify(state.acinfo));
    } catch (e) { }
  }

  /* ------------------------------------------------------------------ */
  /* Ajustes: endereço da API e credenciais                              */
  /* ------------------------------------------------------------------ */

  function setAlert(msg) {
    el.alertBox.className = 'cfg-alert' + (msg ? ' show' : '');
    el.alertBox.textContent = msg || '';
  }

  function openCfg() {
    el.apiBase.value = state.apiBase;
    el.email.value = state.email;
    el.password.value = state.password;
    setAlert('');
    updateCfgStatus();
    el.cfg.hidden = false;
    el.apiBase.focus();
  }

  function closeCfg() { el.cfg.hidden = true; }

  function updateCfgStatus() {
    var user = state.user;
    var linhaUser = user
      ? user.email + ' · ' + user.role +
        (user.airport ? ' · ' + user.airport.icao : ' · sem aeroporto')
      : 'nenhum (entre com e-mail e senha)';

    var expira = state.token && state.tokenExpiresAt > Date.now()
      ? 'token válido por ' + Math.round((state.tokenExpiresAt - Date.now()) / 60000) + ' min'
      : 'sem token';

    el.cfgStatus.textContent =
      'API: ' + state.apiBase + '\n' +
      'usuário: ' + linhaUser + '\n' +
      'estação: ' + state.centerName +
        ' · ' + state.aircraft.length +
        (state.aircraft.length === 1 ? ' aeronave' : ' aeronaves') + ' na última consulta\n' +
      'última leitura: ' + (state.lastFetchAt ? hhmmss(new Date(state.lastFetchAt)) + ' UTC' : '—') +
        ' · ' + expira +
      (state.error ? '\n' + state.error : '');
  }

  el.cfgForm.addEventListener('submit', function (ev) {
    ev.preventDefault();

    var base = el.apiBase.value.trim().replace(/\/+$/, '') || DEFAULT_API;
    var email = el.email.value.trim();
    var senha = el.password.value;

    if (!/^https?:\/\//i.test(base)) {
      setAlert('Endereço da API inválido: use http://localhost:5164');
      return;
    }
    if (!email || !senha) {
      setAlert('Informe e-mail e senha do usuário da API.');
      return;
    }

    saveCreds(base, email, senha);
    closeCfg();
    state.error = '';
    state.nextFetchAt = 0;
    refresh();
  });

  el.btnClearKey.addEventListener('click', function () {
    saveCreds('', '', '');
    state.user = null;
    state.airportId = null;
    state.aircraft = [];
    state.screens = [];
    state.error = '';
    el.apiBase.value = DEFAULT_API;
    el.email.value = '';
    el.password.value = '';
    setAlert('Credenciais removidas deste navegador.');
    updateCfgStatus();
    draw();
  });

  /* olho do campo de senha: alterna texto/senha e troca o icone */
  var btnPw = $('btnTogglePw');
  if (btnPw) {
    btnPw.addEventListener('click', function () {
      var visivel = el.password.type === 'text';
      el.password.type = visivel ? 'password' : 'text';
      btnPw.classList.toggle('on', !visivel);
      btnPw.setAttribute('aria-pressed', String(!visivel));
      btnPw.setAttribute('aria-label', visivel ? 'mostrar senha' : 'ocultar senha');
      el.password.focus();
      try {
        el.password.setSelectionRange(el.password.value.length, el.password.value.length);
      } catch (e) { }
    });
  }

  /* tela cheia: o iPad/Safari antigo usa webkit; sem suporte, o botao some */
  function fullElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function syncFull() {
    if (!el.btnFull) return;
    var ativo = !!fullElement();
    el.btnFull.classList.toggle('on', ativo);
    el.btnFull.setAttribute('aria-pressed', String(ativo));
    el.btnFull.setAttribute('aria-label', ativo ? 'sair da tela cheia' : 'tela cheia');
    fit();
  }

  if (el.btnFull) {
    var alvo = document.documentElement;
    var pode = !!(alvo.requestFullscreen || alvo.webkitRequestFullscreen);

    if (!pode) {
      el.btnFull.hidden = true;
    } else {
      el.btnFull.addEventListener('click', function () {
        try {
          if (fullElement()) {
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
          } else {
            (alvo.requestFullscreen || alvo.webkitRequestFullscreen).call(alvo);
          }
        } catch (e) { }
      });

      document.addEventListener('fullscreenchange', syncFull);
      document.addEventListener('webkitfullscreenchange', syncFull);
    }
  }

  el.btnCfg.addEventListener('click', openCfg);
  el.btnCloseCfg.addEventListener('click', closeCfg);

  el.cfg.addEventListener('click', function (ev) {
    if (ev.target === el.cfg) closeCfg();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !el.cfg.hidden) { closeCfg(); return; }

    /* no modo demo, as setas trocam de tela sem esperar a rodada de 30 s */
    if (!state.demo || !el.cfg.hidden || !state.screens.length) return;
    if (ev.key === 'ArrowRight') {
      nextScreen();
    } else if (ev.key === 'ArrowLeft') {
      state.screenIndex = (state.screenIndex + state.screens.length - 1) % state.screens.length;
      state.lastPageAt = Date.now();
      draw();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Copiar a tela atual                                                 */
  /* ------------------------------------------------------------------ */

  /* texto da tela no formato de strip: uma linha por bloco do painel.
     Devolve null quando a tela nao e de voo (sem voos, erro, boot). */
  function screenText() {
    var s = state.screens[state.screenIndex] || state.screens[0];
    var hora = hhmmss(new Date()) + ' UTC';

    /* sem voo na tela nao ha o que copiar */
    if (!s || s.type !== 'flight') return null;

    var d = s.data;
    var lvl = levelOf(d);
    var linha = [];

    linha.push(d.flight + (airlineName(d) ? ' \u00b7 ' + airlineName(d) : ''));
    linha.push((d.origin ? codeOf(d.origin) : '---') + ' -> ' + (d.destination ? codeOf(d.destination) : '---'));
    linha.push((d.model || 'TYPE ?') + (lvl ? ' \u00b7 ' + lvl : ''));
    linha.push('DEP ' + clockOf(d.depMs) + ' \u00b7 ETA ' + clockOf(d.etaMs) + ' UTC');
    linha.push(distLine(d));
    linha.push(hora);

    return linha.join('\n');
  }

  var toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:99;' +
        'padding:6px 12px;border-radius:4px;background:#14351f;border:1px solid #2f7a4b;' +
        'color:#d7ffe4;font:12px/1.2 ui-monospace,Menlo,monospace;pointer-events:none;' +
        'opacity:0;transition:opacity .15s';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, 1400);
  }

  /* area de transferencia: clipboard API e, se ela nao estiver disponivel
     (http fora de localhost, permissao negada), o velho execCommand */
  function copyText(texto) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = texto;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) toast('COPIED');
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(function () { toast('COPIED'); }, fallback);
    } else {
      fallback();
    }
  }

  /* clicar no painel copia a tela atual; as setas e a rodada de 30 s
     continuam trocando de voo */
  el.panel.addEventListener('click', function () {
    var texto = screenText();
    if (texto) copyText(texto);
  });

  /* ------------------------------------------------------------------ */
  /* Fonia: play e gravação (o gravador é o /radio-recorder.js)          */
  /* ------------------------------------------------------------------ */

  state.wantPlay = false;

  function startAudio() {
    state.wantPlay = true;
    try {
      el.player.src = STREAM_URL + '?t=' + Date.now();
      el.player.load();
      var p = el.player.play();
      if (p && p.catch) p.catch(function () { /* autoplay bloqueado */ });
    } catch (e) { }
  }

  function stopAudio() {
    state.wantPlay = false;
    el.player.pause();
  }

  el.playBtn.addEventListener('click', function () {
    if (el.player.paused) startAudio();
    else stopAudio();
  });

  el.player.addEventListener('playing', function () {
    el.playBtn.classList.add('playing');
    el.playBtn.setAttribute('aria-pressed', 'true');
  });

  el.player.addEventListener('pause', function () {
    el.playBtn.classList.remove('playing');
    el.playBtn.setAttribute('aria-pressed', 'false');
  });

  /* stream caiu: tenta de novo enquanto o botão estiver "tocando" */
  el.player.addEventListener('error', function () {
    if (!state.wantPlay) return;
    setTimeout(function () { if (state.wantPlay) startAudio(); }, 3000);
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() > state.nextFetchAt) refresh();
  });

  /* ------------------------------------------------------------------ */
  /* Tamanho do painel na tela                                           */
  /* ------------------------------------------------------------------ */

  function fit() {
    var w = window.innerWidth, h = window.innerHeight;
    var byW = (w - 40) / W;
    var byH = (h - 150) / H;
    var cell = Math.min(byW, byH, 9);
    cell = Math.max(1.2, Math.round(cell * 100) / 100);
    document.documentElement.style.setProperty('--cell', cell + 'px');
  }

  /* ------------------------------------------------------------------ */
  /* Modo demo: telas com dados falsos, sem rede e sem login             */
  /*                                                                     */
  /* Abra /painel/?demo=<cenário> para congelar o painel num cenário e   */
  /* ajustar o desenho sem depender da API. A barra no rodapé troca de   */
  /* cenário; ← → trocam de tela dentro do cenário. Sem o parâmetro na   */
  /* URL, nada deste bloco executa.                                      */
  /* ------------------------------------------------------------------ */

  /* O demo nao tem API local: os logos vem do AirGateway de producao, que
     ja publica wwwroot/airlines. Sobrescreva com ?api= se precisar. */
  var DEMO_API = 'https://airgateway.iguspotters.com.br';

  var DEMO_AIRPORTS = {
    SBFI: { iata: 'IGU', icao: 'SBFI', city: 'Foz do Iguaçu', lat: -25.593485, lon: -54.490306 },
    SARI: { iata: 'IGR', icao: 'SARI', city: 'Puerto Iguazú', lat: -25.737300, lon: -54.473500 },
    SGES: { iata: 'AGT', icao: 'SGES', city: 'Ciudad del Este', lat: -25.454600, lon: -54.843600 },
    SBGR: { iata: 'GRU', icao: 'SBGR', city: 'São Paulo', lat: -23.435600, lon: -46.473100 },
    SBGL: { iata: 'GIG', icao: 'SBGL', city: 'Rio de Janeiro', lat: -22.810000, lon: -43.250600 },
    SBCA: { iata: 'CAC', icao: 'SBCA', city: 'Cascavel', lat: -25.000300, lon: -53.500800 },
    SAEZ: { iata: 'EZE', icao: 'SAEZ', city: 'Buenos Aires', lat: -34.822200, lon: -58.535800 }
  };

  /* monta uma aeronave no formato que normalizeLive() devolve, populando
     os mesmos caches que o ADSBDB preenche em produção */
  function demoFlight(o) {
    var a = {
      icao: o.icao,
      callsign: o.callsign,
      country: o.country || 'Brazil',
      lat: o.lat,
      lon: o.lon,
      alt: o.alt == null ? null : o.alt,
      onGround: !!o.onGround,
      speed: o.speed == null ? null : o.speed,
      track: o.track == null ? 0 : o.track,
      vrate: o.vrate == null ? null : o.vrate,
      d: o.d == null ? 0 : o.d,
      kind: o.kind,
      status: o.kind === 'arr' ? 'approaching' : o.kind === 'dep' ? 'departing' : 'overflight',
      observedAt: new Date().toISOString()
    };

    if (o.from || o.to) {
      state.routes[a.callsign] = {
        airline: o.airline || null,
        origin: o.from ? DEMO_AIRPORTS[o.from] : null,
        destination: o.to ? DEMO_AIRPORTS[o.to] : null,
        t: Date.now()
      };
    }
    if (o.ac) state.acinfo[a.icao] = { model: o.ac, t: Date.now() };
    if (o.depMinAgo != null) state.depSeen.set(a.icao, Date.now() - o.depMinAgo * 60000);

    return a;
  }

  var DEMO = {
    arrival: function () {
      return {
        aircraft: [demoFlight({
          icao: 'e48a11', callsign: 'TAM3344', kind: 'arr',
          lat: -25.5052, lon: -54.3801, alt: 1400, speed: 95, vrate: -3.1, d: 15,
          airline: { name: 'LATAM', iata: 'LA', icao: 'TAM' },
          from: 'SBGR', to: 'SBFI', ac: 'AIRBUS A320-214'
        })]
      };
    },

    departure: function () {
      return {
        aircraft: [demoFlight({
          icao: 'e48b22', callsign: 'GLO1234', kind: 'dep',
          lat: -25.6505, lon: -54.5512, alt: 900, speed: 110, vrate: 7.2, d: 6,
          airline: { name: 'GOL', iata: 'G3', icao: 'GLO' },
          from: 'SBFI', to: 'SBGR', ac: 'BOEING 737-8EH', depMinAgo: 4
        })]
      };
    },

    overflight: function () {
      return {
        aircraft: [demoFlight({
          icao: 'e48c33', callsign: 'ARG1773', kind: 'over', country: 'Argentina',
          lat: -25.3100, lon: -54.3000, alt: 10668, speed: 231, vrate: 0, d: 38,
          airline: { name: 'AEROLINEAS', iata: 'AR', icao: 'ARG' },
          from: 'SARI', to: 'SAEZ', ac: 'BOEING 737-8SH'
        })]
      };
    },

    /* sem rota e sem modelo: exercita os fallbacks ('-> ?', 'TYPE ?') */
    unknown: function () {
      return {
        aircraft: [demoFlight({
          icao: 'a1b2c3', callsign: 'PRABC', kind: 'over',
          lat: -25.4400, lon: -54.6600, alt: 1600, speed: 62, vrate: 0, d: 22
        })]
      };
    },

    /* cinco voos: testa o contador 1/5 e a rodada de 30 s */
    multi: function () {
      return {
        aircraft: [
          demoFlight({
            icao: 'e48a11', callsign: 'TAM3344', kind: 'arr',
            lat: -25.5052, lon: -54.3801, alt: 1400, speed: 95, vrate: -3.1, d: 15,
            airline: { name: 'LATAM', iata: 'LA', icao: 'TAM' },
            from: 'SBGR', to: 'SBFI', ac: 'AIRBUS A320-214'
          }),
          demoFlight({
            icao: 'e48b22', callsign: 'GLO1234', kind: 'dep',
            lat: -25.6505, lon: -54.5512, alt: 900, speed: 110, vrate: 7.2, d: 6,
            airline: { name: 'GOL', iata: 'G3', icao: 'GLO' },
            from: 'SBFI', to: 'SBGR', ac: 'BOEING 737-8EH', depMinAgo: 4
          }),
          demoFlight({
            icao: 'e48c33', callsign: 'ARG1773', kind: 'over', country: 'Argentina',
            lat: -25.3100, lon: -54.3000, alt: 10668, speed: 231, vrate: 0, d: 38,
            airline: { name: 'AEROLINEAS', iata: 'AR', icao: 'ARG' },
            from: 'SARI', to: 'SAEZ', ac: 'BOEING 737-8SH'
          }),
          demoFlight({
            icao: 'e48d44', callsign: 'AZU4567', kind: 'arr',
            lat: -25.7000, lon: -54.6200, alt: 2600, speed: 118, vrate: -4.5, d: 18,
            airline: { name: 'AZUL', iata: 'AD', icao: 'AZU' },
            from: 'SBCA', to: 'SBFI', ac: 'ATR 72-600'
          }),
          demoFlight({
            icao: 'e48e55', callsign: 'JSM9988', kind: 'dep',
            lat: -25.5600, lon: -54.4200, alt: 1500, speed: 125, vrate: 8.1, d: 9,
            airline: { name: 'JETSMART', iata: 'JA', icao: 'JSM' },
            from: 'SBFI', to: 'SARI', ac: 'AIRBUS A320-232', depMinAgo: 7
          })
        ]
      };
    },

    empty: function () { return { aircraft: [] }; },

    /* um cenario por logo ja publicado em wwwroot/airlines do AirGateway */
    GLO: function () {
      return { aircraft: [demoFlight({
        icao: 'e48b22', callsign: 'GLO1234', kind: 'dep',
        lat: -25.6505, lon: -54.5512, alt: 900, speed: 110, vrate: 7.2, d: 6,
        airline: { name: 'GOL', iata: 'G3', icao: 'GLO' },
        from: 'SBFI', to: 'SBGR', ac: 'BOEING 737-8EH', depMinAgo: 4
      })] };
    },

    TAM: function () {
      return { aircraft: [demoFlight({
        icao: 'e48a11', callsign: 'TAM3344', kind: 'arr',
        lat: -25.5052, lon: -54.3801, alt: 1400, speed: 95, vrate: -3.1, d: 15,
        airline: { name: 'LATAM', iata: 'LA', icao: 'TAM' },
        from: 'SBGR', to: 'SBFI', ac: 'AIRBUS A320-214'
      })] };
    },

    LTG: function () {
      return { aircraft: [demoFlight({
        icao: 'e48f66', callsign: 'LTG8765', kind: 'dep',
        lat: -25.5800, lon: -54.5200, alt: 2400, speed: 140, vrate: 6.4, d: 12,
        airline: { name: 'LATAM', iata: 'LA', icao: 'LTG' },
        from: 'SBFI', to: 'SBGL', ac: 'AIRBUS A321-231', depMinAgo: 9
      })] };
    },

    AZU: function () {
      return { aircraft: [demoFlight({
        icao: 'e48d44', callsign: 'AZU4567', kind: 'arr',
        lat: -25.7000, lon: -54.6200, alt: 2600, speed: 118, vrate: -4.5, d: 18,
        airline: { name: 'AZUL', iata: 'AD', icao: 'AZU' },
        from: 'SBCA', to: 'SBFI', ac: 'ATR 72-600'
      })] };
    },

    ARG: function () {
      return { aircraft: [demoFlight({
        icao: 'e48c33', callsign: 'ARG1773', kind: 'over', country: 'Argentina',
        lat: -25.3100, lon: -54.3000, alt: 10668, speed: 231, vrate: 0, d: 38,
        airline: { name: 'AEROLINEAS', iata: 'AR', icao: 'ARG' },
        from: 'SARI', to: 'SAEZ', ac: 'BOEING 737-8SH'
      })] };
    },

    THY: function () {
      return { aircraft: [demoFlight({
        icao: '4bb1a2', callsign: 'THY216', kind: 'over', country: 'Turkey',
        lat: -25.4200, lon: -54.3000, alt: 11887, speed: 249, vrate: 0, d: 62,
        airline: { name: 'TURKISH', iata: 'TK', icao: 'THY' },
        from: 'SBGR', to: 'LTFM', ac: 'AIRBUS A350-941'
      })] };
    },

    JSM: function () {
      return { aircraft: [demoFlight({
        icao: 'e48e55', callsign: 'JSM9988', kind: 'dep',
        lat: -25.5600, lon: -54.4200, alt: 1500, speed: 125, vrate: 8.1, d: 9,
        airline: { name: 'JETSMART', iata: 'JA', icao: 'JSM' },
        from: 'SBFI', to: 'SARI', ac: 'AIRBUS A320-232', depMinAgo: 7
      })] };
    },

    'err-login': function () {
      return { aircraft: [], errorKind: 'nocreds', error: 'Configure e-mail e senha da API em Configurações.' };
    },

    'err-auth': function () {
      return { aircraft: [], errorKind: 'auth', error: 'Login recusado pela API.' };
    },

    'err-net': function () {
      return { aircraft: [], errorKind: 'http', error: 'Could not reach the API (demo).' };
    }
  };

  function demoParam() {
    var m = /[?&]demo=([^&]*)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* ?api=http://host:porta aponta o demo para outra instancia do AirGateway
     (util quando a API local nao esta na 5164) */
  function demoApiParam() {
    var m = /[?&]api=([^&]*)/.exec(location.search);
    return m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : '';
  }

  function applyDemo(name) {
    if (!name || !DEMO[name]) return false;

    state.routes = {};
    state.acinfo = {};
    state.depSeen = new Map();

    var cenario = DEMO[name]();

    state.demo = name;
    state.apiBase = demoApiParam() || DEMO_API;
    state.centerName = DEMO_AIRPORTS.SBFI.icao;
    state.airport = DEMO_AIRPORTS.SBFI;
    state.lat = DEMO_AIRPORTS.SBFI.lat;
    state.lon = DEMO_AIRPORTS.SBFI.lon;
    state.aircraft = cenario.aircraft || [];
    state.lastFetchAt = Date.now();
    state.error = cenario.error || '';
    state.errorKind = cenario.errorKind || '';
    state.user = null;
    state.email = cenario.errorKind === 'nocreds' ? '' : 'demo@iguspotters.com.br';
    state.password = cenario.errorKind === 'nocreds' ? '' : 'demo';

    buildScreens();
    draw();
    demoBar(name);
    return true;
  }

  function demoGo(name) {
    var partes = location.search.replace(/^\?/, '').split('&').filter(function (p) {
      return p && p.indexOf('demo=') !== 0;
    });
    partes.push('demo=' + encodeURIComponent(name));
    location.search = partes.join('&');
  }

  function demoBar(atual) {
    var bar = document.createElement('div');
    bar.setAttribute('data-demo-bar', '1');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;display:flex;flex-wrap:wrap;' +
      'align-items:center;gap:4px;padding:6px 8px;background:#0b0b0b;border-top:1px solid #262626;' +
      'font:11px/1.2 ui-monospace,Menlo,monospace;color:#8a8a8a';

    var rotulo = document.createElement('span');
    rotulo.textContent = 'demo';
    rotulo.style.cssText = 'margin-right:4px;color:#565656';
    bar.appendChild(rotulo);

    Object.keys(DEMO).forEach(function (key) {
      var botao = document.createElement('button');
      var ativo = key === atual;
      botao.type = 'button';
      botao.textContent = key;
      botao.style.cssText = 'cursor:pointer;padding:3px 7px;border-radius:3px;border:1px solid #333;' +
        'font:inherit;background:' + (ativo ? '#1f6b3a' : '#151515') + ';' +
        'color:' + (ativo ? '#e6ffe9' : '#b5b5b5');
      botao.addEventListener('click', function () { demoGo(key); });
      bar.appendChild(botao);
    });

    var dica = document.createElement('span');
    dica.textContent = '← → switch screen · click the panel to copy';
    dica.style.cssText = 'margin-left:auto;color:#4c4c4c';
    bar.appendChild(dica);

    document.body.appendChild(bar);

    /* a barra ocupa o rodape: sobe o dock para nao cobrir play/gravar/ajustes */
    var dock = document.querySelector('.dock');
    if (dock) dock.style.bottom = (bar.offsetHeight + 10) + 'px';
  }

  /* ------------------------------------------------------------------ */
  /* Inicialização                                                       */
  /* ------------------------------------------------------------------ */

  function init() {
    loadCreds();
    loadCaches();

    state.lastPageAt = Date.now();

    if (!applyDemo(demoParam())) draw();

    window.addEventListener('resize', fit);
    fit();

    setInterval(tick, 1000);
    if (!state.demo) refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
