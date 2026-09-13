/* ==========================================================================
   RADIO ANALYTICS — Instrumentação GA4 (gtag) do player de fonia ATC (SBFI)
   --------------------------------------------------------------------------
   Mede: funil (clique -> começa a ouvir), tempo de escuta real, buffering,
   erros, reconexões, volume/mudo, escuta em segundo plano e tempo de vida
   do ouvinte. Não altera nada da lógica do player — apenas observa.

   Como usar: carregar DEPOIS do script do player.
     <script src="/radio-analytics.js"></script>

   Debug: abrir a página com ?radio_debug=1 e ver os eventos no console.

   Ajustes sem editar o arquivo (declarar antes deste script):
     window.SBFI_RADIO_ANALYTICS = { heartbeatMs: 15000, stream: 'sbfi' };
   ========================================================================== */
(function () {
  'use strict';

  if (window.__sbfiRadioAnalyticsLoaded) return;
  window.__sbfiRadioAnalyticsLoaded = true;

  /* ------------------------------------------------------------------ */
  /* CONFIGURAÇÃO                                                        */
  /* ------------------------------------------------------------------ */
  var CONFIG = Object.assign({
    stream: 'sbfi',
    streamUrl: 'ic.io.tec.br/sbfi',
    heartbeatMs: 30000,   // intervalo do "batimento" que mede tempo de escuta
    engagedSeconds: 30,   // a partir daqui a visita conta como "engajada"
    debug: /[?&]radio_debug=1/.test(window.location.search),
  }, window.SBFI_RADIO_ANALYTICS || {});

  var LS_LISTENER = 'sbfi_listener';        // perfil do ouvinte (persistente)
  var SS_VISIT = 'sbfi_visit_listen';       // acumulado da visita (aba/sessão)
  var SS_SYNCED = 'sbfi_lifetime_synced';   // evita contar 2x após reload

  var ERROR_NAMES = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src_not_supported' };

  // Limites de frequência (stream instável pode gerar centenas de eventos)
  var BUFFER_MIN_MS = 500;        // abaixo disso é micro-parada: só acumula
  var BUFFER_START_DELAY_MS = 2000; // só reporta a parada se ela persistir
  var BUFFER_REPORT_GAP_MS = 5000;  // no máximo 1 report de buffer a cada 5s
  var TRIM_REPORT_GAP_MS = 30000;   // no máximo 1 report de correção de latência a cada 30s
  var PLAY_DEDUPE_MS = 1000;        // ignora evento 'play' duplicado em sequência

  /* ------------------------------------------------------------------ */
  /* STORAGE (com fallback em memória p/ modo privado)                   */
  /* ------------------------------------------------------------------ */
  var memory = {};

  function memoryStore() {
    return {
      getItem: function (k) { return k in memory ? memory[k] : null; },
      setItem: function (k, v) { memory[k] = String(v); },
      removeItem: function (k) { delete memory[k]; },
    };
  }

  function getStore(kind) {
    try {
      var s = kind === 'local' ? window.localStorage : window.sessionStorage;
      return s || memoryStore();
    } catch (e) {
      return memoryStore();
    }
  }

  var storeLocal = getStore('local');
  var storeSession = getStore('session');

  function readJSON(store, key) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeJSON(store, key, value) {
    try { store.setItem(key, JSON.stringify(value)); } catch (e) { /* ignora */ }
  }

  /* ------------------------------------------------------------------ */
  /* UTILITÁRIOS                                                         */
  /* ------------------------------------------------------------------ */
  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) { /* ignora */ }
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function round(n, d) {
    var f = Math.pow(10, d === undefined ? 1 : d);
    return Math.round((Number(n) || 0) * f) / f;
  }

  function now() { return Date.now(); }

  function clean(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    });
    return out;
  }

  function displayMode() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
      if (navigator.standalone) return 'standalone';
      if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen';
    } catch (e) { /* ignora */ }
    return 'browser';
  }

  function connectionType() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return c && c.effectiveType ? c.effectiveType : 'unknown';
  }

  function connectionDownlink() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return c && typeof c.downlink === 'number' ? c.downlink : undefined;
  }

  function cohort(minutes) {
    if (minutes <= 0) return '0min';
    if (minutes < 5) return '1-5min';
    if (minutes < 30) return '5-30min';
    if (minutes < 120) return '30min-2h';
    if (minutes < 600) return '2h-10h';
    return '10h+';
  }

  /* ------------------------------------------------------------------ */
  /* IDENTIDADE: ouvinte (localStorage) e visita (sessionStorage)        */
  /* ------------------------------------------------------------------ */
  var stored = readJSON(storeLocal, LS_LISTENER);
  var isNewListener = !stored || !stored.id;

  var listener = {
    id: isNewListener ? uuid() : stored.id,
    firstSeen: isNewListener ? new Date().toISOString() : (stored.firstSeen || new Date().toISOString()),
    totalSeconds: isNewListener ? 0 : (Number(stored.totalSeconds) || 0),
    totalPlays: isNewListener ? 0 : (Number(stored.totalPlays) || 0),
    visits: isNewListener ? 1 : (Number(stored.visits) || 0) + 1,
    lastSeen: new Date().toISOString(),
  };
  writeJSON(storeLocal, LS_LISTENER, listener);

  var storedVisit = readJSON(storeSession, SS_VISIT);
  var visit = {
    id: (storedVisit && storedVisit.id) || uuid(),
    seconds: (storedVisit && Number(storedVisit.seconds)) || 0,
    plays: (storedVisit && Number(storedVisit.plays)) || 0,
    errors: (storedVisit && Number(storedVisit.errors)) || 0,
    bufferedMs: (storedVisit && Number(storedVisit.bufferedMs)) || 0,
    startedAt: (storedVisit && storedVisit.startedAt) || new Date().toISOString(),
  };
  writeJSON(storeSession, SS_VISIT, visit);

  /* ------------------------------------------------------------------ */
  /* ENVIO PARA O GA4                                                    */
  /* ------------------------------------------------------------------ */
  function gtagSend(name, params, beacon) {
    var payload = clean(params);
    if (beacon) payload.transport_type = 'beacon';

    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, payload);
      } else {
        // gtag.js bloqueado (adblock) ou ainda não carregado: mantém o formato
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push(['event', name, payload]);
      }
    } catch (e) { /* nunca quebrar o player por causa de analytics */ }

    // Gancho opcional: permite espelhar eventos no backend próprio
    // (ex.: window.SBFI_RADIO_ANALYTICS_SINK = (name, params) => ...)
    try {
      if (typeof window.SBFI_RADIO_ANALYTICS_SINK === 'function') {
        window.SBFI_RADIO_ANALYTICS_SINK(name, payload);
      }
    } catch (e) { /* ignora */ }

    if (CONFIG.debug) console.log('%c[radio-analytics] ' + name, 'color:#0f0', payload);
  }

  function setUserProperties() {
    var minutes = Math.round(listener.totalSeconds / 60);
    var props = {
      listener_type: isNewListener ? 'new' : 'returning',
      listener_cohort: cohort(minutes),
      listener_lifetime_min: String(Math.min(minutes, 999999)),
      listener_plays: String(Math.min(listener.totalPlays, 999999)),
    };
    try {
      if (typeof window.gtag === 'function') window.gtag('set', 'user_properties', props);
    } catch (e) { /* ignora */ }
  }

  // Parâmetros comuns a todos os eventos (aceita vários objetos para mesclar)
  function base() {
    var params = {
      stream: CONFIG.stream,
      listener_id: listener.id,
      listener_type: isNewListener ? 'new' : 'returning',
      visit_id: visit.id,
      visit_plays: visit.plays,
      visit_listen_seconds: Math.round(visit.seconds),
      display_mode: displayMode(),
    };
    for (var i = 0; i < arguments.length; i++) {
      var extra = arguments[i];
      if (!extra) continue;
      Object.keys(extra).forEach(function (k) { params[k] = extra[k]; });
    }
    return params;
  }

  /* ------------------------------------------------------------------ */
  /* ESTADO DO PLAYER                                                    */
  /* ------------------------------------------------------------------ */
  var player = null;
  var play = null;          // instância de escuta atual
  var clickPending = false; // o último play foi disparado por clique?
  var clickAt = 0;
  var userPauseIntent = false;
  var lastFailureAt = 0;
  var lastVolumeSent = null;
  var lastVolumeTriggerAt = 0;
  var volumeTimer = null;
  var exitSent = false;
  var backgroundSent = false;

  function newPlay(source) {
    return {
      id: uuid(),
      source: source,
      startedAt: now(),       // hora em que o play começou
      clockFrom: 0,           // timestamp em que o cronômetro (re)iniciou
      seconds: 0,             // segundos acumulados nesta instância
      synced: 0,              // segundos já somados em visit.seconds
      playCount: 0,           // quantas vezes deu play (reconexões contam)
      reconnects: 0,
      bufferMs: 0,
      bufferFrom: 0,
      bufferTimer: null,
      lastBufferReportAt: 0,
      lastTrimReportAt: 0,
      trims: 0,
      stalls: 0,              // paradas >= BUFFER_MIN_MS
      stallsSuppressed: 0,    // paradas não reportadas por causa do rate limit
      lastPlayAt: 0,
      endedAt: 0,
      firstClickAt: 0,
      firstEver: false,
      firstPlayReported: false,
    };
  }

  function startClock() {
    if (!play || play.clockFrom) return;
    play.clockFrom = now();
  }

  function stopClock() {
    if (!play || !play.clockFrom) return;
    play.seconds += (now() - play.clockFrom) / 1000;
    play.clockFrom = 0;
  }

  function currentSeconds() {
    if (!play) return 0;
    return play.seconds + (play.clockFrom ? (now() - play.clockFrom) / 1000 : 0);
  }

  function syncVisit() {
    if (!play) return;
    var total = currentSeconds();
    var delta = total - play.synced;
    if (delta > 0) {
      visit.seconds += delta;
      play.synced = total;
      writeJSON(storeSession, SS_VISIT, visit);
    }
  }

  function bufferHealth() {
    try {
      if (!player || !player.buffered || player.buffered.length === 0) return 0;
      var end = player.buffered.end(player.buffered.length - 1);
      return Math.max(0, end - player.currentTime);
    } catch (e) {
      return 0;
    }
  }

  function volumePct() {
    if (!player) return 0;
    return Math.round((player.muted ? 0 : player.volume) * 100);
  }

  function isEffectivelyMuted() {
    if (!player) return true;
    return !!(player.muted || player.volume === 0);
  }

  /* ------------------------------------------------------------------ */
  /* HEARTBEAT — é isso que mede o tempo de escuta                       */
  /* ------------------------------------------------------------------ */
  var heartbeatId = null;

  function playStateParams() {
    return {
      play_id: play.id,
      play_source: play.source,
      play_seconds: round(currentSeconds(), 1),
      play_count: play.playCount,
      reconnects: play.reconnects,
      buffer_health_s: round(bufferHealth(), 2),
      buffer_total_s: round(play.bufferMs / 1000, 1),
      volume_pct: volumePct(),
      muted: isEffectivelyMuted() ? 'yes' : 'no',
      visible: document.visibilityState,
      connection_type: connectionType(),
    };
  }

  function heartbeat() {
    if (!play || !player || player.paused) return;
    syncVisit();
    gtagSend('radio_heartbeat', base(playStateParams()), true);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatId = setInterval(heartbeat, CONFIG.heartbeatMs);
  }

  function stopHeartbeat() {
    if (heartbeatId) clearInterval(heartbeatId);
    heartbeatId = null;
  }

  function stopBufferTimer() {
    if (play && play.bufferTimer) {
      clearTimeout(play.bufferTimer);
      play.bufferTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* HANDLERS DE EVENTOS                                                 */
  /* ------------------------------------------------------------------ */
  function onPlayClick() {
    if (!player) return;
    var willPlay = player.paused;
    clickPending = willPlay;
    clickAt = now();
    userPauseIntent = !willPlay;

    gtagSend('radio_play_click', base({
      action: willPlay ? 'play' : 'pause',
      first_click_of_visit: visit.plays === 0 ? 'yes' : 'no',
      ms_since_page_load: Math.round(performance.now ? performance.now() : 0),
    }));
  }

  function onPlayEvent() {
    var t = now();
    var fromClick = clickPending;
    clickPending = false;
    var recentFailure = lastFailureAt > 0 && (t - lastFailureAt) < 15000;

    // Evento "play" duplicado em sequência (o player dispara play/loadstart
    // várias vezes ao reconectar): conta uma vez só.
    if (!fromClick && play && (t - play.lastPlayAt) < PLAY_DEDUPE_MS) return;

    var isNewInstance = !play || fromClick;
    if (isNewInstance) {
      play = newPlay(fromClick ? 'button' : (recentFailure ? 'reconnect' : 'auto'));
      play.firstEver = visit.plays === 0;
      play.firstClickAt = clickAt;
      visit.plays += 1;
      writeJSON(storeSession, SS_VISIT, visit);
      listener.totalPlays += 1;
      writeJSON(storeLocal, LS_LISTENER, listener);
    } else {
      play.reconnects += 1;
      play.endedAt = 0;
    }
    play.playCount += 1;
    play.lastPlayAt = t;

    startClock();
    startHeartbeat();

    gtagSend('radio_play', base(playStateParams(), {
      click_to_play_ms: fromClick && play.firstClickAt ? Math.round(t - play.firstClickAt) : undefined,
      page_load_to_play_ms: Math.round(performance.now ? performance.now() : 0),
      is_first_play_of_visit: play.firstEver ? 'yes' : 'no',
      is_first_play_ever: play.firstEver && isNewListener ? 'yes' : 'no',
      downlink_mbps: connectionDownlink(),
    }), true);

    if (play.firstEver && !play.firstPlayReported) {
      play.firstPlayReported = true;
      gtagSend('radio_first_play', base({
        play_id: play.id,
        play_source: play.source,
        page_load_to_play_ms: Math.round(performance.now ? performance.now() : 0),
        listener_visits: listener.visits,
      }), true);
    }
  }

  function onPauseEvent() {
    if (!play) return;
    stopClock();
    syncVisit();
    stopHeartbeat();
    stopBufferTimer();

    var seconds = currentSeconds();
    var reason = userPauseIntent ? 'user'
      : (player.error ? 'error'
        : (document.visibilityState === 'hidden' ? 'background' : 'stream'));
    userPauseIntent = false;
    play.endedAt = now();

    if (player.ended) return;                          // 'ended' reporta por conta própria
    if (reason !== 'user' && seconds < 0.5) return;    // interrupção instantânea de conexão

    gtagSend('radio_pause', base(playStateParams(), {
      paused_by: reason,
      total_buffer_s: round(play.bufferMs / 1000, 1),
    }), true);
  }

  function onBufferStart(kind) {
    if (!play || play.bufferFrom) return;
    play.bufferFrom = now();
    stopClock(); // tempo travado em buffering não é tempo de escuta

    // Só reporta se a parada persistir — evita enxurrada de eventos
    if (play.bufferTimer) clearTimeout(play.bufferTimer);
    play.bufferTimer = setTimeout(function () {
      play.bufferTimer = null;
      if (!play || !play.bufferFrom) return;
      if (now() - play.lastBufferReportAt < BUFFER_REPORT_GAP_MS) return;
      play.lastBufferReportAt = now();
      gtagSend('radio_buffer_start', base({
        kind: kind,
        play_id: play.id,
        play_seconds: round(currentSeconds(), 1),
        buffer_health_s: round(bufferHealth(), 2),
        stalls: play.stalls,
        connection_type: connectionType(),
      }), true);
    }, BUFFER_START_DELAY_MS);
  }

  function onBufferEnd(kind) {
    if (!play) return;
    if (play.bufferTimer) { clearTimeout(play.bufferTimer); play.bufferTimer = null; }
    if (!play.bufferFrom) { startClock(); return; }

    var ms = now() - play.bufferFrom;
    play.bufferFrom = 0;

    // Totais sempre exatos (aparecem no heartbeat e no radio_exit)
    play.bufferMs += ms;
    visit.bufferedMs += ms;
    writeJSON(storeSession, SS_VISIT, visit);

    startClock();

    if (ms < BUFFER_MIN_MS) return;   // micro-parada: só acumula

    play.stalls += 1;
    if (now() - play.lastBufferReportAt < BUFFER_REPORT_GAP_MS) {
      play.stallsSuppressed += 1;
      return;
    }
    play.lastBufferReportAt = now();

    gtagSend('radio_buffer_end', base({
      kind: kind,
      play_id: play.id,
      buffer_ms: Math.round(ms),
      buffer_total_ms: Math.round(play.bufferMs),
      stalls: play.stalls,
      stalls_suppressed: play.stallsSuppressed,
      play_seconds: round(currentSeconds(), 1),
    }), true);
  }

  function onError() {
    var t = now();
    lastFailureAt = t;
    stopClock();
    syncVisit();
    stopBufferTimer();
    visit.errors += 1;
    writeJSON(storeSession, SS_VISIT, visit);

    var err = player.error;
    gtagSend('radio_error', base({
      play_id: play ? play.id : undefined,
      error_code: err ? err.code : 0,
      error_name: err ? (ERROR_NAMES[err.code] || 'unknown') : 'unknown',
      error_message: err && err.message ? String(err.message).slice(0, 100) : undefined,
      network_state: player.networkState,
      ready_state: player.readyState,
      play_seconds: play ? round(currentSeconds(), 1) : 0,
      reconnects: play ? play.reconnects : 0,
      visit_errors: visit.errors,
    }), true);
  }

  function onEnded() {
    if (!play) return;
    stopClock();
    syncVisit();
    stopHeartbeat();
    stopBufferTimer();
    gtagSend('radio_stream_ended', base(playStateParams()), true);
    play.endedAt = now();
  }

  function onSeeked() {
    if (!play) return;
    var seconds = currentSeconds();
    play.trims += 1;

    // O player corrige a latência em loop quando o stream oscila:
    // reporta o primeiro ajuste (entrada no "ao vivo") e depois no máximo 1 a cada 30s.
    var isJoin = play.trims === 1;
    if (!isJoin && (now() - play.lastTrimReportAt) < TRIM_REPORT_GAP_MS) return;
    play.lastTrimReportAt = now();

    gtagSend('radio_latency_trim', base({
      play_id: play.id,
      kind: seconds < 3 ? 'live_edge' : 'trim',
      play_seconds: round(seconds, 1),
      trims: play.trims,
      buffer_health_s: round(bufferHealth(), 2),
    }));
  }

  function volumeEvent(trigger) {
    if (!player) return;

    if (trigger === 'player') {
      // O evento volumechange do player costuma vir logo depois do clique/slider
      if (now() - lastVolumeTriggerAt < 1500) return;
    } else {
      lastVolumeTriggerAt = now();
    }

    var pct = volumePct();
    if (lastVolumeSent !== null && Math.abs(pct - lastVolumeSent) < 5) return;
    lastVolumeSent = pct;
    gtagSend('radio_volume', base({
      play_id: play ? play.id : undefined,
      trigger: trigger,
      volume_pct: pct,
      muted: isEffectivelyMuted() ? 'yes' : 'no',
      play_seconds: play ? round(currentSeconds(), 1) : 0,
    }));
  }

  function onVolumeChanged() {
    if (volumeTimer) clearTimeout(volumeTimer);
    volumeTimer = setTimeout(function () { volumeEvent('player'); }, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* SAÍDA / SEGUNDO PLANO                                               */
  /* ------------------------------------------------------------------ */
  function persistLifetimeSeconds() {
    var synced = Number(storeSession.getItem(SS_SYNCED) || 0);
    var total = Math.round(visit.seconds);
    var delta = total - synced;
    if (delta > 0) {
      listener.totalSeconds += delta;
      listener.lastSeen = new Date().toISOString();
      writeJSON(storeLocal, LS_LISTENER, listener);
      try { storeSession.setItem(SS_SYNCED, String(total)); } catch (e) { /* ignora */ }
    }
    setUserProperties();
  }

  function onHidden() {
    if (!play || player.paused) return;
    if (backgroundSent) return;
    backgroundSent = true;
    syncVisit();
    gtagSend('radio_background', base(playStateParams()), true);
  }

  function onShown() {
    backgroundSent = false;
    if (play && player && !player.paused) startClock();
  }

  function sendExit() {
    if (exitSent) return;
    exitSent = true;
    stopClock();
    syncVisit();
    stopHeartbeat();
    stopBufferTimer();

    var listened = Math.round(visit.seconds);
    persistLifetimeSeconds();

    gtagSend('radio_exit', base({
      play_id: play ? play.id : undefined,
      last_play_seconds: play ? round(currentSeconds(), 1) : 0,
      total_buffer_ms: Math.round(play ? play.bufferMs : visit.bufferedMs),
      visit_errors: visit.errors,
      engaged: listened >= CONFIG.engagedSeconds ? 'yes' : 'no',
      engaged_30s: listened >= 30 ? 'yes' : 'no',
      engaged_5min: listened >= 300 ? 'yes' : 'no',
      lifetime_listen_min: Math.round(listener.totalSeconds / 60),
      active_seconds: Math.round((now() - Date.parse(visit.startedAt) || 0) / 1000),
    }), true);
  }

  /* ------------------------------------------------------------------ */
  /* INSTRUMENTAÇÃO                                                     */
  /* ------------------------------------------------------------------ */
  function uniqueElements(selectors) {
    var seen = [];
    selectors.forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el && seen.indexOf(el) === -1) seen.push(el);
    });
    return seen;
  }

  /* ------------------------------------------------------------------ */
  /* INTERFACE: DIALOGO "SOBRE" E TEMA                                   */
  /* ------------------------------------------------------------------ */
  function onInfoOpen() {
    gtagSend('radio_info_open', base());
  }

  // Lê o tema num tick seguinte: o handler da página troca o atributo no
  // mesmo clique, e a ordem dos listeners não é garantida.
  function onThemeClick() {
    setTimeout(function () {
      gtagSend('radio_theme_change', base({
        theme: document.documentElement.getAttribute('data-theme') === 'red' ? 'red' : 'green',
      }));
    }, 0);
  }

  function bindUiExtras() {
    uniqueElements(['#infoBtn'])
      .forEach(function (btn) { btn.addEventListener('click', onInfoOpen, true); });

    uniqueElements(['#themeToggleBtn'])
      .forEach(function (btn) { btn.addEventListener('click', onThemeClick, true); });
  }

  function init() {
    bindUiExtras();

    player = document.getElementById('radioPlayer');
    if (!player) return; // página sem player

    uniqueElements(['#playButton', '#audioPlayBtn', '.play-btn'])
      .forEach(function (btn) { btn.addEventListener('click', onPlayClick, true); });

    uniqueElements(['#volumeButton', '#audioVolBtn'])
      .forEach(function (btn) {
        btn.addEventListener('click', function () { volumeEvent('button'); }, true);
      });

    uniqueElements(['#volumeSlider', '#audioVolSlider'])
      .forEach(function (slider) {
        slider.addEventListener('change', function () { volumeEvent('slider'); });
      });

    player.addEventListener('play', onPlayEvent);
    player.addEventListener('pause', onPauseEvent);
    player.addEventListener('playing', function () { onBufferEnd('resume'); });
    player.addEventListener('waiting', function () { onBufferStart('waiting'); });
    player.addEventListener('stalled', function () { onBufferStart('stalled'); });
    player.addEventListener('error', onError);
    player.addEventListener('ended', onEnded);
    player.addEventListener('seeked', onSeeked);
    player.addEventListener('volumechange', onVolumeChanged);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') onHidden(); else onShown();
    });
    window.addEventListener('pagehide', sendExit, true);

    setUserProperties();

    if (CONFIG.debug) {
      console.log('[radio-analytics] ativo', { listener: listener, visit: visit, config: CONFIG });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // API pública (debug/testes/eventos manuais)
  window.sbfiRadioAnalytics = {
    track: gtagSend,
    infoOpen: onInfoOpen,
    themeChange: onThemeClick,
    config: CONFIG,
    getState: function () { return { listener: listener, visit: visit, play: play }; },
  };
})();
