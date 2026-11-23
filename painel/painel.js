/* ==========================================================================
   /painel — painel de LED físico de 320 × 160 mm (P2.5 = 128 × 64 LEDs RGB).

   A página é preta; no meio dela fica o painel. Tudo é desenhado num buffer
   de 128 × 64 pixels (1 pixel = 1 LED), com fonte própria de 5 × 7 para o
   texto sair realmente em matriz de pontos. As telas se alternam na ordem
   que o servidor manda (chegadas, partidas e sobrevoos), cada uma com o
   layout do painel da foto: logo, companhia, voo, rota, modelo, DEP/ETA e
   km até o destino.

   Fonte de dados — e só ela: GET /api/sbfi/live do AirGateway.Api (operação
   SbfiLive), público, sem login e sem query string. O servidor entrega as
   telas prontas, na ordem, com os textos truncados para as 128 × 64 LEDs e
   os logos já quantizados; este arquivo não calcula rota, ETA, nível de
   voo nem baixa logo — só renderiza o que chegou (o cliente é o
   /painel/painel-live.js). A tela de Informações também lê desse estado.

   Página secundária e oculta: não é linkada em lugar nenhum do site.

   Ajuste visual sem rede: /painel/?demo=<cenário> congela o painel num
   cenário de fixtures do próprio endpoint (arrival, departure, overflight,
   unknown, multi, trend, empty, stale, err-signal, err-rate, err-net). A
   barra inferior troca de cenário e as setas ← → trocam de tela. Sem o
   parâmetro, o modo demo não executa.
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
  var PAGE_MS = 30000;              // fallback quando o servidor não diz mais
  /* logo, em LEDs: 31 × 31 — altura idêntica ao bloco do cabeçalho (0..30).
     O bitmap do backend (36 × 36) é reduzido para 31 × 31 pelo min() do
     drawLogo, sem distorcer. */
  var LOGO_W = 31, LOGO_H = 31;
  var LOGO_GAP = 4;                 // LEDs livres entre a logo e o texto
  /* x do texto do cabeçalho, depois do respiro (35). Com 93 px livres, a
     rota no máximo ("2/12 FM IGU -> SAO PAULO") perde mais uma letra do
     destino; com nível de voo, a linha se ajusta sem encostar nele. */
  var LOGO_TEXT_X = LOGO_W + LOGO_GAP;

  /* ritmo vertical do voo: todas as linhas com o mesmo vão, medidas de baixo
     para cima. O vão do cabeçalho é 1 LED maior (TOP_GAP) para a régua verde
     cair centrada. Com o glifo de 7 linhas: companhia 0..6, voo 12..18,
     régua 21, rota 24..30, modelo 35..41, DEP/ETA 46..52, distância 57..63 —
     a última encostada na base. */
  var LINE_H = 7;                   // altura do glifo 5 × 7
  var LINE_GAP = 4;                 // LEDs livres entre as linhas de texto
  var TOP_GAP = 5;                  // vão do cabeçalho (régua centralizada)
  var DIST_Y = H - LINE_H;                          // 57
  var DEP_Y = DIST_Y - LINE_H - LINE_GAP;           // 46
  var MODEL_Y = DEP_Y - LINE_H - LINE_GAP;          // 35
  var ROUTE_Y = MODEL_Y - LINE_H - LINE_GAP;        // 24
  var FLIGHT_Y = ROUTE_Y - LINE_H - TOP_GAP;        // 12
  var AIRLINE_Y = FLIGHT_Y - LINE_H - TOP_GAP;      // 0
  var RULE_Y = FLIGHT_Y + LINE_H + 2;               // 21: 2 LEDs de cada lado

  /* ------------------------------------------------------------------ */
  /* Constantes de dados                                                 */
  /* ------------------------------------------------------------------ */

  /* AirGateway.Api: endereço fixo, sem campo na tela (não há nada para
     configurar). Para apontar o painel a outra instância (dev), use
     /painel/?api=http://host:porta. */
  var DEFAULT_API = 'https://airgateway.iguspotters.com.br';
  var API_BASE = apiParam() || DEFAULT_API;

  /* cobertura do painel: os três aeroportos da tríplice fronteira — só como
     último recurso, quando a tela de erro/vazio vier sem as linhas prontas */
  var AREA_LABEL = 'IGU / IGR / AGT';

  /* cores de fallback para a sigla quando a companhia não traz cor */
  var SIGLA_COLOR = [255, 246, 232];

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
    btnInfo: $('btnInfo'), info: $('info'), infoStatus: $('infoStatus'),
    btnCloseInfo: $('btnCloseInfo'),
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

  /* O painel não tem mais regra de negócio: o estado de dados É o estado do
     cliente do endpoint (painel-live.js), consultado por liveState(). Aqui
     ficam só a rodada em exibição, o relógio das telas e o modo demo. */
  var state = {
    screenIndex: 0,
    lastPageAt: 0,
    pageMs: PAGE_MS,
    demo: '',                 // cenário de /painel/?demo=..., ver bloco "Modo demo"
    wantPlay: false
  };

  /* cliente do GET /api/sbfi/live (trocado pelo demo quando ?demo=) */
  var live = PainelLive.createClient({
    apiBase: API_BASE,
    onUpdate: function () { updateInfo(); }
  });

  function liveState() { return live.getState(); }

  /* ------------------------------------------------------------------ */
  /* Dados                                                               */
  /* ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* horários sempre em UTC (o painel é operacional) */
  function hhmm(d) { return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }
  function hhmmss(d) {
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  /* ISO -> "hh:mm" em UTC; '--:--' quando não há horário */
  function utcClock(iso) {
    if (!iso) return '--:--';
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '--:--';
    return hhmm(d);
  }

  /* 30 s (ou pageSeconds do servidor) por tela */
  function pageMs() {
    var ls = liveState();
    var secs = ls && ls.live && ls.live.rotation && ls.live.rotation.pageSeconds;
    return (secs && secs > 0 ? secs : 30) * 1000;
  }

  /* ------------------------------------------------------------------ */
  /* Ciclo de atualização                                                */
  /* ------------------------------------------------------------------ */

  function refresh() {
    if (state.demo) return;
    if (document.hidden) return;

    /* o voo na tela não pisca quando a rodada é atualizada: guarda o icao e
       recoloca a tela nele depois (como o buildScreens antigo fazia) */
    var cur = currentScreen();
    var keep = cur && cur.type === 'flight' ? { icao: cur.icao, callsign: cur.callsign } : null;

    live.load().then(function () {
      var ls = liveState();
      state.pageMs = pageMs();
      if (keep) {
        var idx = live.findScreen(keep);
        if (idx >= 0) state.screenIndex = idx;
      }
      keepScreen();
      log('GET', ls.url, '· fase', ls.phase, '· telas',
        (ls.live && ls.live.screens.length) || 0,
        ls.live ? (ls.live.stale ? '· STALE ' + ls.live.staleAgeSeconds + 's' : '') : '',
        ls.error ? '· ' + ls.error : '');
      draw();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Telas                                                               */
  /* ------------------------------------------------------------------ */

  /* rodada em exibição: o array do servidor já vem ordenado e cortado */
  function screens() {
    var ls = liveState();
    return (ls && ls.live && ls.live.screens) || [];
  }

  function currentScreen() {
    var list = screens();
    if (!list.length) return null;
    if (state.screenIndex >= list.length) state.screenIndex = 0;
    return list[state.screenIndex] || list[0];
  }

  /* A posição "montada no cliente" de antes some: o contador n/m agora é o
     positionText do servidor. Aqui só garantimos que o índice cabe na rodada
     nova (o voo em si é recolocado por refresh()). */
  function keepScreen() {
    var list = screens();
    if (!list.length) { state.screenIndex = 0; return; }
    if (state.screenIndex >= list.length) state.screenIndex = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Logo em LEDs                                                        */
  /* ------------------------------------------------------------------ */

  /* Bitmap que o servidor já recortou e quantizou (40 × 27, RGB565): aqui só
     desenha. Sem bitmap (companhia sem logo, ou logos ainda carregando no
     backend) cai na caixa de LOGO_W × LOGO_H com a sigla de 3 letras. */
  function logoOf(screen) {
    var key = screen && screen.airline && screen.airline.logoKey;
    return key ? live.logoFor(key) : null;
  }

  /* O bitmap chega do servidor no tamanho do bloco do painel (40 × 27) e é
     exibido exatamente como veio: sem recorte, sem limpar fundo e sem
     clarear. Qualquer tratamento de cor aqui seria inventar um desenho que o
     servidor não mandou. A proporção é só uma proteção para payload fora do
     contrato — no caso normal (40 × 27) ela desenha pixel a pixel. */
  function drawLogo(screen, logoY) {
    var img = logoOf(screen);
    if (!img) return false;

    var lw = img.width, lh = img.height;
    var esc = Math.min(LOGO_W / lw, LOGO_H / lh);
    var dw = Math.round(lw * esc), dh = Math.round(lh * esc);
    var ox = Math.round((LOGO_W - dw) / 2);
    var oy = Math.round((LOGO_H - dh) / 2);

    for (var y = 0; y < dh; y++) {
      var sy = Math.min(lh - 1, Math.floor(y / esc));
      for (var x = 0; x < dw; x++) {
        var sx = Math.min(lw - 1, Math.floor(x / esc));
        var i = (sy * lw + sx) * 4;
        if (img.rgba[i + 3] < 24) continue;
        px(ox + x, oy + y + logoY, [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]);
      }
    }
    return true;
  }

  function drawSigla(screen, logoY) {
    var air = (screen && screen.airline) || {};
    var col = colorOf(air.color) || SIGLA_COLOR;

    for (var i = 0; i < LOGO_W; i++) {
      px(i, logoY, col); px(i, logoY + LOGO_H - 1, col);
    }
    for (var j = 0; j < LOGO_H; j++) {
      px(0, j + logoY, col); px(LOGO_W - 1, j + logoY, col);
    }
    var sigla = normalizeText(screen && (screen.badgeText ||
      (screen.airline && (screen.airline.iata || screen.airline.code)) || '?')).slice(0, 3);
    if (!sigla) sigla = '?';
    /* o texto da sigla fica no centro vertical da caixa, qualquer que seja
       LOGO_H */
    text(Math.round((LOGO_W - textWidth(sigla, 1)) / 2), logoY + Math.round((LOGO_H - 7) / 2), sigla, C.white);
  }

  /* cor da companhia no DTO (string "#RRGGBB"); null mantém a sigla branca */
  function colorOf(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }


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

  /* corta a string para caber em maxPx, sem quebrar no meio de nada */
  function truncateToWidth(str, maxPx) {
    var s = normalizeText(str);
    while (s.length > 1 && textWidth(s, 1) > maxPx) s = s.slice(0, -1);
    return s;
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
  /* Desenho das telas                                                   */
  /* ------------------------------------------------------------------ */

  /* Setas de tendencia vertical no bloco de 7 linhas do fim da 2a linha (voo),
     no desenho de ↘ e ↗: a cabeca e o canto inferior (ou superior) direito —
     barra horizontal na ponta e barra vertical na direita (4 LEDs cada) — e
     a haste sai dele na diagonal, da esquerda para a direita. */
  var ARROWS = {
    climbing: ['...####', '.....##', '....#.#', '...#..#', '..#....', '.#.....', '#......'],
    descending: ['#......', '.#.....', '..#....', '...#..#', '....#.#', '.....##', '...####']
  };
  var ARROW_W = 7;

  /* seta origem -> destino em 7 px: haste longa com a ponta encostada.
     O marcador \u0000 no texto da rota e trocado por este bloco. */
  var ROUTE_ARROW = [
    '....#',
    '.....#',
    '......#',
    '#######' + '#',
    '......#',
    '.....#',
    '....#'
  ];
  var ROUTE_MARK = '\u0000';
  var ROUTE_ARROW_W = 8;
  /* LEDs livres de cada lado da seta, entre ela e o código do aeroporto.
     Ficava 1 (de cada lado); a linha da rota ganhou 2 colunas de respiro
     para a direita com 0. */
  var ROUTE_GAP = 0;

  /* largura da rota com a seta dedicada no lugar de '-' + '>' */
  function routeWidth(str) {
    var s = normalizeText(str);
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      /* a seta ocupa o marcador e os dois respiros que a cercam */
      w += ch === ROUTE_MARK ? ROUTE_ARROW_W + 2 * ROUTE_GAP : advanceOf(ch);
    }
    return w - 1;
  }

  /* desenha a rota trocando o marcador pelo glifo da seta */
  function textRoute(x, y, str, maxPx, c) {
    var s = normalizeText(str);
    while (s.length > 2 && routeWidth(s) > maxPx) s = s.slice(0, -1);

    /* a seta é desenhada com 1 LED de respiro de cada lado (o código termina
       no sprite, que inclui a coluna de avanço); com ROUTE_GAP = 0 a rota
       leva 2 colunas a menos do que o routeWidth diz, e o corte abre espaço
       para 2 letras a mais. Assim a rota desenhada nunca passa de maxPx. */
    var desenho = ROUTE_GAP - 1;

    var cx = x;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === ROUTE_MARK) {
        for (var row = 0; row < ROUTE_ARROW.length; row++) {
          for (var col = 0; col < ROUTE_ARROW_W; col++) {
            if (ROUTE_ARROW[row].charAt(col) === '#') px(cx + col, y + row, c);
          }
        }
        cx += ROUTE_ARROW_W + desenho;
        continue;
      }
      text(cx, y, ch, c, 1);
      cx += advanceOf(ch);
    }
  }

  /* largura do bloco da seta (5 do glifo + 1 de respiro) ou 0 se nao houver */
  function arrowOf(trend) {
    return ARROWS[trend] ? ARROWS[trend] : null;
  }

  function drawTrend(trend, xEnd, y) {
    var g = arrowOf(trend);
    if (!g) return;

    /* 'level' nao tem glifo: nada a desenhar. Verde, igual a distancia da
       ultima linha, de quem ela fica ao lado. */
    for (var row = 0; row < g.length; row++) {
      for (var col = 0; col < ARROW_W; col++) {
        if (g[row].charAt(col) === '#') px(xEnd + col, y + row, C.green);
      }
    }
  }

  /* Layout do painel da foto (logo alargada: ocupa as 3 primeiras linhas
     e empurra o texto do cabeçalho para a direita):
       [logo 31x31]    COMPANHIA  (LOGO_GAP: 4 LEDs livres entre os dois)
                    VOO        ↗/↘ (tendencia, fim da 2a linha)
                    ────────── linha verde
                    ORG -> DST           FL### (borda direita)
       MODELO
       DEP hh:mm              ETA hh:mm
       NN KM TO GO                  n/m

     Todos os textos vêm prontos e truncados de GET /api/sbfi/live; os cortes
     por largura daqui só protegem o desenho contra resposta fora do contrato
     (são idempotentes no caso conforme). */
  function drawFlight(s) {
    /* o espaço do logo é sempre reservado, para o texto não pular de lugar
       entre um voo e outro. A logo encosta no topo (linha 0) do bloco das
       3 primeiras linhas (companhia 0..6, voo 12..18, rota 24..30). */
    var logoY = 0;
    if (!drawLogo(s, logoY)) drawSigla(s, logoY);

    /* o cabeçalho (companhia, voo, rota) começa depois da logo + LOGO_GAP
       LEDs de respiro. */
    var tx = LOGO_TEXT_X;

    /* folga em caracteres do nome da companhia: o que sobra até a borda,
       em incrementos de 6 px (1 letra + 1 de respiro) */
    var folga = Math.max(0, Math.floor((W - 1 - tx + 1) / 6));

    /* a seta de tendencia (↗ subindo, ↘ descendo; nada em "level" ou sem
       dado) fecha a 2a linha do painel, a do numero do voo, com 1 LED de
       folga da borda. Ela ocupa as linhas 12..18, entao o meio da linha do
       voo (15) coincide com a linha do meio da seta (15). */
    var trendW = arrowOf(s.verticalTrend) ? ARROW_W - 1 : 0;
    var trendX = W - trendW - 1;
    var vooMax = Math.floor((trendX - (trendW ? 2 : 0) - tx + 1) / 6);

    /* o nível de voo fecha a linha da rota, à direita, e é sempre mostrado:
       a rota é que cede espaço para ele. Com 2 px de vão livre entre os dois
       e o nível de voo inteiro (FL046, 3 letras). */
    var lvl = normalizeText(s.levelText);
    var lvlW = lvl ? textWidth(lvl, 1) : 0;
    var lvlGap = lvl ? 2 : 0;
    var rotaMax = W - tx - 2 - (lvl ? lvlW + lvlGap : 0);

    text(tx, AIRLINE_Y, truncate(s.airlineName, folga), C.white);

    /* a 2a linha é só o voo */
    text(tx, FLIGHT_Y, truncate(s.flight, trendW ? vooMax : folga), C.white);
    if (trendW) drawTrend(s.verticalTrend, trendX, FLIGHT_Y);

    /* linha verde dividindo o cabeçalho (companhia + voo) da rota: fica no
       meio do vão livre (2 LEDs acima, 2 abaixo) */
    for (var k = tx; k < W; k++) px(k, RULE_Y, C.green);

    /* origem/destino: o servidor manda os dois lados (sintéticos ou não) e
       um lado pode vir vazio quando é desconhecido. A seta "->" vira um glifo
       dedicado, como sempre foi. */
    var org = normalizeText(s.originText || '');
    var dst = normalizeText(s.destinationText || '');
    var rota = (org ? org + ' ' : '') + ROUTE_MARK + ' ' + (dst || '?');

    textRoute(tx, ROUTE_Y, rota, rotaMax, C.cyan);
    /* o nível de voo encosta na borda direita: textRight já recua 1 LED da
       borda que recebe, então W + 1 deixa o último LED do FL na coluna 127 */
    if (lvl) textRight(W + 1, ROUTE_Y, lvl, C.cyan);

    /* da rota para baixo, todas as linhas com o mesmo vão (LINE_GAP):
       rota 24..30, modelo 35..41, DEP/ETA 46..52, distancia 57..63 — a ultima
       linha encosta na base do painel (64 linhas, 0..63). */
    text(0, MODEL_Y, truncate(s.model || 'TYPE ?', 21), C.dimText);

    /* DEP e ETA lado a lado (os horários já vêm em UTC, com "--:--" quando
       não há o estimado) */
    var dep = (s.depText || 'DEP  ' + utcClock(s.depAt)).trim();
    var eta = (s.etaText || 'ETA  ' + utcClock(s.etaAt)).trim();
    text(0, DEP_Y, dep, C.amber);
    text(textWidth(dep, 1) + 7, DEP_Y, eta, C.white);

    /* ultima linha: distancia a esquerda e, quando couber, a posicao na
       rodada no fim da linha (positionText do servidor) */
    var pos = normalizeText(s.positionText || '');
    var posW = 0;
    if (pos) {
      posW = textWidth(pos, 1) + 1;
      if (W - 3 - posW < 0) posW = 0;   // sem espaco: esconde o contador
    }

    var distMax = W - 3 - (posW ? posW + 3 : 0);
    text(0, DIST_Y, truncateToWidth(s.distText || '', distMax), C.green);

    if (pos && posW) textRight(W - 1, DIST_Y, pos, C.dimText);
  }

  /* Telas que não são de voo (sem voos / fonte sem dado) chegam prontas no
     endpoint: três linhas + relógio UTC, nas posições e cores de sempre. */
  function linesText3(s, fallback) {
    var l = (s && s.lines) || [];
    return [
      normalizeText(l[0] || fallback[0]),
      normalizeText(l[1] || fallback[1]),
      normalizeText(l[2] || fallback[2])
    ];
  }

  function drawEmpty(s) {
    var l = linesText3(s, [AREA_LABEL, 'NO FLIGHTS', 'NO TRAFFIC']);
    var clock = (s && s.clock) || hhmmss(new Date());

    textCenter(12, l[0], C.cyan);
    textCenter(26, l[1], C.amber);
    textCenter(38, l[2], C.dimText);
    textCenter(52, clock + ' UTC', C.white);
  }

  function drawError(s) {
    var l = linesText3(s, [AREA_LABEL, 'NO SIGNAL', 'API / NET']);
    var clock = (s && s.clock) || hhmmss(new Date());

    textCenter(12, l[0], C.cyan);
    textCenter(24, l[1], C.red);
    textCenter(36, l[2], C.amber);
    textCenter(52, clock + ' UTC', C.white);
  }

  /* Sem rodada nenhuma do servidor: o painel desenha o que ele mesmo sabe
     (ainda não consultou / erro de rede / 429), como antes. */
  function drawClientError() {
    var ls = liveState();
    var kind = ls ? ls.errorKind : '';

    textCenter(12, AREA_LABEL, C.cyan);

    if (!ls || ls.phase === 'boot' || (!ls.errorKind && !ls.lastFetchAt)) {
      textCenter(24, 'STANDBY', C.amber);
      textCenter(36, 'SBFI LIVE', C.dimText);
    } else if (kind === 'rate') {
      /* rate limit do endpoint (429): só esperar */
      textCenter(24, 'TOO MANY TRIES', C.red);
      textCenter(36, 'WAIT A MINUTE', C.amber);
    } else {
      textCenter(24, 'NO SIGNAL', C.red);
      textCenter(36, 'API / NET', C.dimText);
    }

    textCenter(52, hhmmss(new Date()) + ' UTC', C.white);
  }

  function draw() {
    clear();

    var s = currentScreen();
    if (s && s.type === 'flight') drawFlight(s);
    else if (s && s.type === 'empty') drawEmpty(s);
    else if (s && s.type === 'error') drawError(s);
    else drawClientError();

    flush();
  }

  function nextScreen() {
    var list = screens();
    if (list.length > 1) {
      state.screenIndex = (state.screenIndex + 1) % list.length;
    }
    state.lastPageAt = Date.now();
    draw();
  }

  function prevScreen() {
    var list = screens();
    if (list.length > 1) {
      state.screenIndex = (state.screenIndex + list.length - 1) % list.length;
    }
    state.lastPageAt = Date.now();
    draw();
  }

  /* ------------------------------------------------------------------ */
  /* Relógio / ciclo de telas                                            */
  /* ------------------------------------------------------------------ */

  function tick() {
    if (document.hidden) return;

    /* telas de voo trocam na rodada; empty/error ficam até a próxima leitura */
    if (screens().length > 1 && Date.now() - state.lastPageAt > state.pageMs) {
      state.screenIndex = (state.screenIndex + 1) % screens().length;
      state.lastPageAt = Date.now();
    }

    draw();

    /* o rótulo/tempo de gravação vem do /radio-recorder.js */
    if (el.dockStatus) {
      var visivel = !!(el.recordLabel.textContent || el.recordCounter.textContent);
      el.dockStatus.hidden = !visivel;
    }

    var ls = liveState();
    if (ls && Date.now() >= ls.nextFetchAt) {
      if (!state.demo) refresh();
    }

    /* a tela de Informações mostra relógio e estado ao vivo */
    if (el.info && !el.info.hidden) updateInfo();
  }

  /* ------------------------------------------------------------------ */
  /* Persistência                                                        */
  /* ------------------------------------------------------------------ */

  /* O painel público não guarda mais credenciais nem caches de rota: este são
     chaves antigas de quando ele fazia login e consultava o ADSBDB. Elas são
     removidas neste navegador (higiene); o reload do service worker continua. */
  var LS_KEY = 'sbfiPainelApi';          // credenciais antigas — obsoleto
  var LS_ROUTES = 'sbfiRadarRoutes';     // cache do ADSBDB — obsoleto
  var LS_AC = 'sbfiRadarAc';             // cache do ADSBDB — obsoleto
  var STREAM_URL = 'https://ic.io.tec.br/sbfi';

  function purgeLegacyStorage() {
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_ROUTES);
      localStorage.removeItem(LS_AC);
    } catch (e) { }
  }

  /* ------------------------------------------------------------------ */
  /* Informações (a antiga tela de Configurações — só leitura)           */
  /* ------------------------------------------------------------------ */

  function openInfo() {
    el.info.hidden = false;
    updateInfo();
    if (el.btnCloseInfo) el.btnCloseInfo.focus();
  }

  function closeInfo() { el.info.hidden = true; }

  function setInfo(field, value) {
    var node = document.querySelector('[data-info="' + field + '"]');
    if (node) node.textContent = value;
  }

  function stateLabel(ls) {
    if (!ls) return '—';
    if (ls.phase === 'boot') return 'aguardando primeira leitura';
    if (ls.errorKind === 'rate') {
      var wait = ls.retryAfterMs ? ' · aguardar ' + Math.ceil(ls.retryAfterMs / 1000) + ' s' : '';
      return '429 · muitas tentativas' + wait;
    }
    if (ls.errorKind === 'net') return 'SEM SINAL · ' + ls.error;
    if (ls.errorKind === 'server') return 'FONTE FORA DO AR · ' + ls.error;
    if (ls.errorKind) return ls.error || ls.errorKind;
    if (ls.live && ls.live.stale) return 'STALE ' + (ls.live.staleAgeSeconds | 0) + ' s';
    return 'OK';
  }

  function updateInfo() {
    if (!el.info || el.info.hidden) return;

    var ls = liveState();
    var doc = ls && ls.live;
    var ap = doc && doc.airport;
    var n = screens().length;
    var cur = currentScreen();

    setInfo('source', (doc ? 'GET /api/sbfi/live' : 'GET /api/sbfi/live') + ' · ' + (ls ? ls.apiBase : API_BASE));
    setInfo('airport', ap
      ? [ap.icao, ap.iata, ap.name].filter(Boolean).join(' · ')
      : '—');
    setInfo('window', doc && doc.windowMinutes != null ? doc.windowMinutes + ' min' : '—');
    setInfo('rotation', doc && doc.rotation
      ? (n === 1 ? '1 tela' : n + ' telas') + ' · ' + doc.rotation.pageSeconds + ' s/tela'
      : '—');
    setInfo('screen', n ? ((state.screenIndex % n) + 1) + '/' + n +
      (cur && cur.type === 'flight' ? ' · ' + (cur.flight || cur.icao || '') : '') : '—');
    setInfo('updated', doc && doc.generatedAt
      ? hhmmss(new Date(doc.generatedAt)) + ' UTC'
      : '—');
    setInfo('status', stateLabel(ls));
    setInfo('fetched', ls && ls.lastFetchAt ? hhmmss(new Date(ls.lastFetchAt)) + ' UTC' : '—');

    if (el.infoStatus) {
      el.infoStatus.className = 'info-status' +
        (ls && ls.errorKind ? ' bad' : (doc && doc.stale ? ' stale' : ''));
    }

    /* o relógio da tela de Informações anda mesmo sem resposta nova */
    setInfo('clock', hhmmss(new Date()) + ' UTC');
  }

  /* ------------------------------------------------------------------ */
  /* Copiar a tela atual                                                 */
  /* ------------------------------------------------------------------ */

  /* texto da tela no formato de strip: uma linha por bloco do painel.
     Devolve null quando a tela nao e de voo (sem voos, erro, boot). */
  function screenText() {
    var ls = liveState();
    var s = currentScreen();
    var hora = hhmmss(new Date()) + ' UTC';

    /* sem voo na tela nao ha o que copiar */
    if (!s || s.type !== 'flight') return null;

    /* o texto copiado tem setas de verdade; "level" e sem dado vira '-' */
    var seta = s.verticalTrend === 'climbing' ? '\u2197'
      : s.verticalTrend === 'descending' ? '\u2198'
      : '';
    var rota = (s.originText || '---') + ' -> ' + (s.destinationText || '---');
    var linha = [];

    linha.push(String(s.flight || s.icao || '') + (s.airlineName ? ' \u00b7 ' + s.airlineName : ''));
    linha.push(rota);
    linha.push((s.model || 'TYPE ?') + (s.levelText ? ' \u00b7 ' + s.levelText : '') +
      (seta ? ' \u00b7 ' + seta + ' ' + (s.verticalTrend === 'climbing' ? 'CLB' : 'DES') : ''));
    linha.push((s.depText || 'DEP --:--') + ' \u00b7 ' + (s.etaText || 'ETA --:--') + ' UTC');
    linha.push(s.distText || '');
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

  /* clicar no painel copia a tela atual; as setas e a rodada continuam
     trocando de voo */
  el.panel.addEventListener('click', function () {
    var texto = screenText();
    if (texto) copyText(texto);
  });

  /* ------------------------------------------------------------------ */
  /* Fonia: play e gravação (o gravador é o /radio-recorder.js)          */
  /* ------------------------------------------------------------------ */

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
    if (document.hidden) return;
    /* voltou à tela: busca já (o endpoint tem cache de 10 s) e redesenha */
    if (state.demo) { draw(); return; }
    var ls = liveState();
    if (!ls || Date.now() > ls.nextFetchAt) refresh();
  });

  /* ------------------------------------------------------------------ */
  /* Tela cheia                                                          */
  /* ------------------------------------------------------------------ */

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

  el.btnInfo.addEventListener('click', openInfo);
  el.btnCloseInfo.addEventListener('click', closeInfo);

  el.info.addEventListener('click', function (ev) {
    if (ev.target === el.info) closeInfo();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !el.info.hidden) { closeInfo(); return; }

    /* as setas trocam de tela sem esperar a rodada — no demo e na API real */
    if (!el.info.hidden || !screens().length) return;
    if (ev.key === 'ArrowRight') {
      nextScreen();
    } else if (ev.key === 'ArrowLeft') {
      prevScreen();
    }
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
  /* Modo demo: fixtures do endpoint, sem rede                           */
  /*                                                                     */
  /* Abra /painel/?demo=<cenário> para congelar o painel num payload do  */
  /* GET /api/sbfi/live e ajustar o desenho sem depender da rede. A barra */
  /* no rodapé troca de cenário; ← → trocam de tela dentro do cenário.   */
  /* Sem o parâmetro na URL, nada deste bloco executa.                   */
  /* ------------------------------------------------------------------ */

  var DEMO = (function () {
    /* logo real de GOL, capturado do próprio endpoint (RGB565 40 × 27):
       o demo exercita o mesmo caminho do bitmap de produção. */
    var LOGO_TAM = {"code":"TAM","width":40,"height":27,"format":"rgb565","hash":"demo-tam","bitmap":"EKQQpBCkEKQQpBCk977/3//f/9//3//f/9//3/9d6pDq0PT29pv/vv/f/9//3//f/9//3//f/9//3//f/9//3/e+EKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3////////////////////37yL+iK6Kvxzvv0/lv/nv///////////////////////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f////////////////////v/P06OvoiuiK8Iv5Tvpx/BX9uf9e////////////////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9////////////0X/Vj/Hf///9/9mfMR6Uzwi/is+Mz4rPjM+lD8lv5b/9/////////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3///////////8rDoy/IP9FX+m//f/57+OvwU+e/4zPis+Mz4rPis+W7sVvff/////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f///////////zMuiK6IroiulM8vH0tv4a/37/Pf3a/DX6seFOsXCJsnsW73//////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9////////////468vHpTOiK6Iroiuhq6Mvysfz3/rzOfYyaSrYqlzKXU3jvfv/////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3///////////////nv468/TxreiK6IrwiuDMsXB69UL3KncydzJ3Mndj2fe//////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f///////////9F/T3/nv/nv781Fah0HlwUhMydyqXMpcyl0pVehOjltZ8////////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9////////////LR6GrpLLuUfHhC1SI0KjQqVTJ3MndiFKGR4Q74rPjt29X3v//////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3///////////u5R5cFnRMhMqFCo0KhQ6lGPYnVvGPO1Z81PJkJmRefNrN+9+/////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f///////////W3YS5U1YqNCo0U1aVGc6c97///+9erbxsGTq3Kpcyl1NY517/////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9/////////////////nPq2arZrnPv///9/OvZUaW7gylzJ3MpcydzJ3dFn3v//////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3//////////////////////vnsZcjPlr10LWMncydzJ3OrdbuIzardznXv///////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f///////////////////3n3Q4MlQqFCo0KlUyd0sXhJq+PO+f////////////////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9///////////////////+9+UzYqNCoUKjRbl51b1r3/3//////////////////////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3///////////////////735blmO3lRm+PO9+99/vn////////////////////////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f///////////////////339bd97///+9+rdt0OXya97//////////////////////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9//////////////////////3x2tm3xYUzYydTJ3Y9n3v//////////////////////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3///////////////////735blioUKjQqNCpVMpeM2v/f/////////////////////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f///////////////////vflM2KjQiFDJ0dBi1/O9+////////////////////////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9///////////////////+9+a/d0OKWazr33v//////////////////////////////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3////////////////////9/vfv///////////////////////////////////////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpP/f//////////////////////eetfudOu+e////////////////////////////////////3xCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/9////////////////////eea/YqM0sW5z7////////////////////////////////////fEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT/3///////////////////735LFCHyW5bvfv///////////////////////////////////98QpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPe+/9//3//f/9//3//f/9/nPVMUW5W1+/e//9//3//f/9//3//f/9//3//f/9//3//f/9/3vhCkEKQQpBCkEKQQpBCk"};
    var LOGO_GLO = {"code":"GLO","width":40,"height":27,"format":"rgb565","hash":"demo-glo","bitmap":"EKQQpBCkEKQQpBCk+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPrA+sD6wPtD/En87fzt/Ir7Q/rA+sD7hPxq/O387fxr7CrkKuvo80P7pfyr+6b6oPrA+sD6wBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk+sD6oPwp/vn///////////0N+qD8i/87///////////vfcZZvffFdO5W///9cPqg+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6oPwH/zv/3v64/ZH9kP3T+4X8av98/77+uOba3xz3XP/f957V1b223tv///1w+qD6wPrA+sAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPsi/nb///2y+wL6oPqg+qD7Q/8a/979L+wqvdfFc/Po/jX///2y5Cveuv///XD6oPrA+sD6wBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk/Cj/nf86+2T6wPsB/Gn8iv1v///+uPsB3M699+RL+qD8av///pb64fXT///9cPqg+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT8q////lX6oPrA+8b/nf////////3z+sHVEL3X66b6wPul/53++fsC/S////1w+qD6wPrA+sAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPxq/9/+uPrh+sD7Q/3S/hP/fP///lX6wNTvvffr6Pqg/Af/vv7Y+uD9cf///XD6oPrA+sD6wBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk+4T/Gv+9/Ir6oPrA+sD6oP52////fPvn5Eu9+NTw+wL9T////hTzZeZ3///9cPqg+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6wPzM/73/W/2R/Ir8av1P/3z//////xr1084XvdfVUuaZ713ls8VT3tv///52/Iv8q/yr+4UQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPrA+sD9cP/e////////////vf1w/hT/////713GOL33vfe99733vdfeuv/////////////9LxCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk+sD6wPsB/Gr9cP4U/jX9sfxJ+sD7IvyL/ZH+NfWz5M7crtTw3K7r6Pxq/fP98/3z/fP98/woEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6wPrA+sD6wPqg+qD6oPqg+sD6wPrA+sD6oPqg+qD6oPqg+qD6oPrA+qD6oPqg+qD6oPqg+qAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCk+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrAEKQQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKT6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sAQpBCkEKQQpBCkEKQQpBCkEKQQpBCkEKQQpPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wPrA+sD6wBCkEKQQpBCkEKQQpBCk"};

    var AIRPORT = { icao: 'SBFI', iata: 'IGU', name: 'Foz do Iguaçu' };
    var DEP = '2026-11-23T11:30:00Z';
    var ETA = '2026-11-23T13:22:00Z';

    var brand = {
      GLO: { code: 'GLO', name: 'GOL', color: '#FF7A00', logoKey: 'GLO' },
      TAM: { code: 'TAM', name: 'LATAM', color: '#BD5028', logoKey: 'TAM' },
      AZU: { code: 'AZU', name: 'AZUL', color: '#0033A0', logoKey: 'AZU' },
      ARG: { code: 'ARG', name: 'AEROLINEAS', color: '#0B5AA6', logoKey: 'ARG' },
      JSM: { code: 'JSM', name: 'JETSMART', color: '#E4002B', logoKey: 'JSM' },
      PRV: { code: 'PRV', name: 'PRIVATE', color: '#6b6b6b', logoKey: null }
    };

    var NA = { DEP: 'DEP --:--', ETA: 'ETA --:--' };

    /* uma tela de voo no formato exato do SbfiScreenSbfiFlightScreen */
    function flight(o) {
      var air = brand[o.brand] || { code: '', name: '', color: null, logoKey: null };
      return {
        type: 'flight',
        icao: o.icao,
        callsign: o.flight,
        flight: o.flight,
        isPrivate: !o.brand,
        badgeText: o.badge || o.iata || air.code || '',
        airlineName: o.name || air.code || '',
        airline: {
          code: air.code, iata: o.iata || '', name: air.name,
          color: air.color, logoKey: air.logoKey
        },
        origin: o.from || null,
        originSource: o.from ? (o.fromSource || 'route') : 'none',
        originText: o.fromText || '',
        destination: o.to || null,
        destinationSource: o.to ? (o.toSource || 'route') : 'none',
        destinationText: o.toText || '',
        status: o.status,
        verticalTrend: o.trend || null,
        depAt: o.depAt === undefined ? DEP : o.depAt,
        etaAt: o.etaAt === undefined ? ETA : o.etaAt,
        distanceKm: o.km,
        altitudeFt: o.ft || null,
        levelText: o.level || '',
        model: o.model || 'TYPE ?',
        depText: o.dep || NA.DEP,
        etaText: o.eta || NA.ETA,
        distText: o.dist || '',
        index: o.index | 0,
        positionText: o.pos || null
      };
    }

    function doc(screens, extra) {
      var d = {
        generatedAt: new Date().toISOString(),
        windowMinutes: 10,
        stale: false,
        staleAgeSeconds: 0,
        airport: AIRPORT,
        rotation: { pageSeconds: 30, count: screens.length },
        logos: { GLO: LOGO_GLO, TAM: LOGO_TAM },
        screens: screens
      };
      return Object.assign(d, extra || {});
    }

    function single(s, extra) { return doc([s], extra); }

    var ARR = {
      icao: 'e49c05', flight: 'TAM3460', brand: 'TAM', iata: 'LA', name: 'LATAM',
      from: 'SBGR', fromText: 'GRU', to: 'SBFI', toText: 'IGU', toSource: 'center',
      status: 'approaching', trend: 'descending', level: 'FL089',
      model: 'AIRBUS A320-214', dep: 'DEP 11:12', eta: 'ETA 13:15',
      dist: '15 KM TO GO', km: 15, ft: 8900
    };
    var DEP_S = {
      icao: 'e48b22', flight: 'GLO1234', brand: 'GLO', iata: 'G3', name: 'GOL',
      from: 'SBFI', fromText: 'IGU', fromSource: 'center', to: 'SBGR', toText: 'GRU',
      status: 'departing', trend: 'climbing', level: 'FL046',
      model: 'BOEING 737-8EH', dep: 'DEP 13:05', eta: 'ETA 14:05',
      dist: '9 KM FROM ORIGIN', km: 9, ft: 4600
    };
    var OVER = {
      icao: 'e49c05', flight: 'ARG1773', brand: 'ARG', iata: 'AR', name: 'AEROLINEAS',
      from: 'SARI', fromText: 'IGR', to: 'SAEZ', toText: 'AEP',
      status: 'overflight', trend: 'level', level: 'FL350',
      model: 'BOEING 737-8SH', dep: 'DEP 12:58', eta: 'ETA 14:10',
      dist: '38 KM FROM SBFI', km: 38, ft: 35000
    };

    return {
      arrival: function () { return single(flight(ARR)); },
      departure: function () { return single(flight(DEP_S)); },
      overflight: function () { return single(flight(OVER)); },

      /* sem rota e sem modelo: exercita os fallbacks ('-> ?', 'TYPE ?') */
      unknown: function () {
        return single(flight({
          icao: 'a1b2c3', flight: 'PRABC', brand: 'PRV', status: 'overflight',
          trend: null, level: 'FL052', dist: '22 KM FROM SBFI', km: 22, ft: 5200
        }));
      },

      /* cinco voos: testa o contador n/5 e a rodada de 30 s */
      multi: function () {
        var lista = [
          flight(ARR), flight(DEP_S), flight(OVER),
          flight(Object.assign({}, ARR, {
            icao: 'e48d44', flight: 'AZU4567', brand: 'AZU', iata: 'AD', name: 'AZUL',
            from: 'SBCA', fromText: 'CAC', level: 'FL085', model: 'ATR 72-600',
            dep: 'DEP 12:30', eta: 'ETA 13:40', dist: '18 KM TO GO', km: 18, ft: 8500
          })),
          flight(Object.assign({}, DEP_S, {
            icao: 'e48e55', flight: 'JSM9988', brand: 'JSM', iata: 'JA', name: 'JETSMART',
            to: 'SARI', toText: 'IGR', level: 'FL150', model: 'AIRBUS A320-232',
            dep: 'DEP 12:50', eta: 'ETA 13:50', dist: '24 KM FROM ORIGIN', km: 24, ft: 15000
          }))
        ];
        var d = doc(lista);
        d.screens.forEach(function (s, i) { s.index = i; s.positionText = (i + 1) + '/' + lista.length; });
        return d;
      },

      /* seta de tendencia: os quatro casos do verticalTrend da API */
      trend: function () {
        var lista = [
          flight({
            icao: 'b10002', flight: 'GLO1001', brand: 'GLO', iata: 'G3', name: 'GOL',
            from: 'SBFI', fromText: 'IGU', fromSource: 'center', to: 'SBGR', toText: 'GRU',
            status: 'departing', trend: 'climbing', level: 'FL046',
            model: 'BOEING 737-8EH', dep: 'DEP 13:05', eta: 'ETA 14:05',
            dist: '9 KM FROM ORIGIN', km: 9, ft: 4600
          }),
          flight({
            icao: 'b10003', flight: 'TAM2002', brand: 'TAM', iata: 'LA', name: 'LATAM',
            from: 'SBGR', fromText: 'GRU', to: 'SBFI', toText: 'IGU', toSource: 'center',
            status: 'approaching', trend: 'descending', level: 'FL089',
            model: 'AIRBUS A320-214', dep: 'DEP 11:12', eta: 'ETA 13:15',
            dist: '15 KM TO GO', km: 15, ft: 8900
          }),
          flight({
            icao: 'b10004', flight: 'ARG3003', brand: 'ARG', iata: 'AR', name: 'AEROLINEAS',
            from: 'SARI', fromText: 'IGR', to: 'SAEZ', toText: 'AEP',
            status: 'overflight', trend: 'level', level: 'FL350',
            model: 'BOEING 737-8SH', dep: 'DEP 12:58', eta: 'ETA 14:10',
            dist: '38 KM FROM SBFI', km: 38, ft: 35000
          }),
          flight({
            icao: 'b10005', flight: 'JSM4004', brand: 'JSM', iata: 'JA', name: 'JETSMART',
            from: 'SBCA', fromText: 'CAC', to: 'SAEZ', toText: 'AEP',
            status: 'overflight', trend: null, level: 'FL390',
            model: 'AIRBUS A320-232', dist: '62 KM FROM SBFI', km: 62, ft: 39000
          })
        ];
        var d = doc(lista);
        d.screens.forEach(function (s2, i) { s2.index = i; s2.positionText = (i + 1) + '/' + lista.length; });
        return d;
      },

      empty: function () {
        return single({
          type: 'empty', index: 0, positionText: null,
          lines: [AREA_LABEL, 'NO FLIGHTS', 'NO TRAFFIC'], clock: hhmmss(new Date())
        });
      },

      /* fonte parada: última resposta boa, com stale=true */
      stale: function () {
        var d = doc([
          flight(ARR), flight(DEP_S), flight(OVER)
        ]);
        d.screens.forEach(function (s, i) { s.index = i; s.positionText = (i + 1) + '/3'; });
        d.stale = true;
        d.staleAgeSeconds = 75;
        d.generatedAt = new Date(Date.now() - 75 * 1000).toISOString();
        return d;
      },

      /* tela 'error' do servidor (sem dados ao vivo) */
      'err-signal': function () {
        return single({
          type: 'error', reason: 'no-signal', index: 0, positionText: null,
          lines: [AREA_LABEL, 'NO SIGNAL', 'API / NET'], clock: hhmmss(new Date())
        });
      },

      /* falhas do próprio navegador (sem payload): o painel desenha a espera */
      'err-rate': function () {
        return { errorKind: 'rate', error: 'Muitas tentativas (429)', status: 429, retryAfterMs: 180000 };
      },

      'err-net': function () {
        return { errorKind: 'net', error: 'Sem resposta da API', status: 0 };
      }
    };
  })();

  function demoParam() {
    var m = /[?&]demo=([^&]*)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* ?api=http://host:porta aponta o cliente para outra instancia do AirGateway
     (util quando a API local nao e a de producao) */
  function apiParam() {
    var m = /[?&]api=([^&]*)/.exec(location.search);
    return m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : '';
  }

  /* Um cliente de mentira no mesmo formato do PainelLive: o painel desenha a
     partir do mesmo estado, então o demo exercita o caminho real do desenho. */
  function demoClient(payload) {
    var st = {
      apiBase: API_BASE, url: API_BASE + '/api/sbfi/live',
      phase: payload.live ? 'ok' : 'error',
      live: payload.live || null,
      lastFetchAt: Date.now(), nextFetchAt: Infinity, inflight: null,
      error: payload.error || '', errorKind: payload.errorKind || '',
      status: payload.status || 0, retryAfterMs: payload.retryAfterMs || 0
    };
    /* mesmo decodificador do cliente real: o demo passa pelo mesmo desenho */
    var cache = {};
    function logoFor(key) {
      var dto = st.live && st.live.logos && st.live.logos[key];
      if (!dto) return null;
      var k = dto.hash || key;
      if (cache[k]) return cache[k];
      try { cache[k] = PainelLive.decodeLogo(dto); } catch (e) { cache[k] = null; }
      return cache[k];
    }

    return {
      load: function () { return Promise.resolve(st); },
      logoFor: logoFor,
      screen: function () { var s = st.live && st.live.screens; return s && s[0] || null; },
      findScreen: function () { return -1; },
      reset: function () { },
      getState: function () { return st; }
    };
  }

  function applyDemo(name) {
    if (!name || !DEMO[name]) return false;

    var payload = DEMO[name]();
    if (payload && Array.isArray(payload.screens)) {
      payload = { live: PainelLive.normalize(payload), error: '', errorKind: '' };
    }

    state.demo = name;
    state.screenIndex = 0;
    state.lastPageAt = Date.now();

    live = demoClient(payload);
    state.pageMs = pageMs();

    draw();
    demoBar(name);

    /* no demo a tela de Informações já mostra o estado congelado */
    if (!el.info.hidden) updateInfo();
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

    /* a barra ocupa o rodape: sobe o dock para nao cobrir play/gravar/informacoes */
    var dock = document.querySelector('.dock');
    if (dock) dock.style.bottom = (bar.offsetHeight + 10) + 'px';
  }

  /* ------------------------------------------------------------------ */
  /* Inicialização                                                       */
  /* ------------------------------------------------------------------ */

  function init() {
    purgeLegacyStorage();

    state.lastPageAt = Date.now();
    state.pageMs = pageMs();

    if (!applyDemo(demoParam())) draw();

    window.addEventListener('resize', fit);
    fit();

    /* a rodada de páginas anda a cada segundo; a leitura de dados é
       agendada pelo próprio cliente (10 s, entre telas) */
    setInterval(tick, 1000);
    if (!state.demo) refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
