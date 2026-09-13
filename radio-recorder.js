/* ==========================================================================
   RADIO RECORDER — grava a fonia ao vivo e baixa um MP3
   --------------------------------------------------------------------------
   Como funciona: o stream do Icecast já é MP3 puro (MPEG-2 Layer III, 32 kbps).
   Em vez de recodificar no navegador — o MediaRecorder não gera MP3 e o
   captureStream não existe no Safari/iOS — este módulo abre uma conexão
   paralela (o CORS do servidor permite), copia os bytes crus e, ao parar,
   corta o lixo inicial até o primeiro frame e monta o .mp3.

   Vantagens: MP3 de verdade, sem re-codificação, sem perda de qualidade,
   CPU quase zero e funciona no iPhone. Custo: uma conexão extra de ~4 KB/s.

   Independe do player: grava com o áudio tocando ou não.

   Uso: o botão e os elementos de estado precisam existir na página (index.html):
     <button class="record-btn" id="recordBtn" type="button"
       data-label-idle="" data-label-recording="Gravando">
       <span class="material-icons">fiber_manual_record</span>
     </button>
     ...
       <span class="record-label" id="recordLabel"></span>
       <span class="record-counter" id="recordCounter"></span>
   Rótulos vazios em `data-label-idle` significam "não mostrar nada parado".
   e o script ser carregado:
     <script src="/radio-recorder.js" defer></script>

   Ajustes opcionais (declarar antes deste script):
     window.SBFI_RADIO_RECORDER = { maxMinutes: 60, streamUrl: '...' };

   Debug: abrir a página com ?radio_rec_debug=1
   ========================================================================== */
(function () {
  'use strict';

  if (window.__sbfiRadioRecorderLoaded) return;
  window.__sbfiRadioRecorderLoaded = true;

  var CONFIG = Object.assign({
    streamUrl: 'https://ic.io.tec.br/sbfi',
    maxMinutes: 240,     // trava de segurança (~14 MB por hora, em 32 kbps)
    minBytes: 4096,      // abaixo disso foi curto demais (~1s) para valer arquivo
    retryDelayMs: 2000,  // espera entre tentativas se a conexão cair
    maxRetries: 5,
    debug: /[?&]radio_rec_debug=1/.test(window.location.search),
  }, window.SBFI_RADIO_RECORDER || {});

  var LABEL_IDLE = 'Gravar Fonia ATC';
  var LABEL_RECORDING = 'Gravando Fonia ATC';

  var btn = null;
  var label = null;
  var counter = null;
  var recording = false;
  var chunks = [];
  var totalBytes = 0;
  var startedAt = 0;
  var controller = null;
  var tickTimer = null;
  var msgTimer = null;
  var failures = 0;

  /* ------------------------------------------------------------------ */
  /* UTILITÁRIOS                                                         */
  /* ------------------------------------------------------------------ */
  function log() {
    if (!CONFIG.debug) return;
    console.log.apply(console, ['[gravador]'].concat(Array.prototype.slice.call(arguments)));
  }

  // Reaproveita o módulo de métricas (radio-analytics.js), se estiver na página
  function track(name, params) {
    try {
      var m = window.sbfiRadioAnalytics;
      if (m && typeof m.track === 'function') m.track(name, params, true);
    } catch (e) { /* métricas nunca devem quebrar o gravador */ }
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function streamUrl() {
    return CONFIG.streamUrl + '?t=' + Date.now() + '&r=' + Math.random().toString(36).slice(2, 8);
  }

  function formatTime(ms) {
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return (h > 0 ? h + ':' + pad(m) : pad(m)) + ':' + pad(s);
  }

  function formatSize(bytes) {
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fileName() {
    var d = new Date();
    return 'sbfi-fonia-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.mp3';
  }

  /* ------------------------------------------------------------------ */
  /* CAPTURA DOS BYTES                                                   */
  /* ------------------------------------------------------------------ */
  async function drain(signal) {
    var res = await fetch(streamUrl(), { mode: 'cors', cache: 'no-store', signal: signal });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status + ' sem corpo');

    var reader = res.body.getReader();
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      if (r.value && r.value.length) {
        chunks.push(r.value);
        totalBytes += r.value.length;
        failures = 0;
      }
    }
  }

  async function run(signal) {
    while (recording) {
      try {
        await drain(signal);
      } catch (e) {
        if (!recording || (e && e.name === 'AbortError')) return;
        failures += 1;
        log('falha na conexão (' + failures + '/' + CONFIG.maxRetries + '):', e.message);
        if (failures > CONFIG.maxRetries) {
          stop(true, 'A conexão caiu e não voltou');
          return;
        }
        await delay(CONFIG.retryDelayMs * failures);
        continue;
      }
      // O stream terminou sozinho: se ainda estamos gravando, reconecta
      if (!recording) return;
      await delay(500);
    }
  }

  /* ------------------------------------------------------------------ */
  /* MONTAGEM DO ARQUIVO                                                 */
  /* ------------------------------------------------------------------ */
  // O começo da conexão traz alguns bytes fora de frame; corta até o
  // primeiro cabeçalho MP3 válido para o arquivo abrir limpo.
  function findFirstFrame(b) {
    var limit = Math.min(b.length - 4, 8192);
    for (var i = 0; i < limit; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      var version = (b[i + 1] >> 3) & 3;   // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      var layer = (b[i + 1] >> 1) & 3;     // 1=Layer III
      var bitrate = (b[i + 2] >> 4) & 15;
      var sampleRate = (b[i + 2] >> 2) & 3;
      if (version !== 1 && layer === 1 && bitrate > 0 && bitrate < 15 && sampleRate !== 3) return i;
    }
    return 0;
  }

  function assemble() {
    var buf = new Uint8Array(totalBytes);
    var off = 0;
    chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
    var start = findFirstFrame(buf);
    if (start > 0) log('cortando ' + start + ' bytes iniciais fora de frame');
    return start > 0 ? buf.subarray(start) : buf;
  }

  function download(bytes) {
    var name = fileName();
    var blob = new Blob([bytes], { type: 'audio/mpeg' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 60000);
    log('download:', name, formatSize(bytes.length));
  }

  /* ------------------------------------------------------------------ */
  /* INTERFACE                                                           */
  /* ------------------------------------------------------------------ */
  function setup() {
    btn = document.getElementById('recordBtn');
    label = document.getElementById('recordLabel');
    counter = document.getElementById('recordCounter');
    if (!btn) {
      log('sem #recordBtn na página: gravador não iniciado');
      return;
    }

    // Rótulos vêm do HTML (data-label-*), com fallback
    if (btn.dataset.labelIdle !== undefined) LABEL_IDLE = btn.dataset.labelIdle;
    if (btn.dataset.labelRecording) LABEL_RECORDING = btn.dataset.labelRecording;

    btn.addEventListener('click', onButtonClick);
    setUi(false);
    log('gravador pronto');
  }

  function setLabel(text) {
    if (label) label.textContent = text;
  }

  function setUi(state) {
    if (!btn) return;
    btn.classList.toggle('recording', state);
    btn.title = state ? 'Parar gravação e baixar o MP3' : 'Gravar fonia (MP3)';
    btn.setAttribute('aria-label', state ? 'Parar gravação e baixar o MP3' : 'Gravar fonia (MP3)');
    setLabel(state ? LABEL_RECORDING : LABEL_IDLE);
    if (label) label.classList.remove('warn');
    if (counter) counter.textContent = '';
  }

  function tick() {
    if (!recording || !counter) return;
    var elapsed = Date.now() - startedAt;
    counter.textContent = formatTime(elapsed);
    if (elapsed > CONFIG.maxMinutes * 60000) stop(true, 'Limite de ' + CONFIG.maxMinutes + ' min atingido');
  }

  // Mostra o resultado por alguns segundos no próprio rótulo da faixa
  function flash(message) {
    if (!label) return;
    clearTimeout(msgTimer);
    setLabel(message);
    label.classList.add('warn');
    msgTimer = setTimeout(function () {
      if (!recording) {
        label.classList.remove('warn');
        setLabel(LABEL_IDLE);
      }
    }, 4000);
  }

  /* ------------------------------------------------------------------ */
  /* CONTROLE                                                            */
  /* ------------------------------------------------------------------ */
  function onButtonClick() {
    if (recording) stop(false);
    else start();
  }

  function start() {
    if (recording) return;
    recording = true;
    chunks = [];
    totalBytes = 0;
    failures = 0;
    startedAt = Date.now();
    controller = new AbortController();

    setUi(true);
    tick();
    tickTimer = setInterval(tick, 1000);
    log('gravação iniciada');
    track('radio_record_start', { trigger: 'button' });

    run(controller.signal);
  }

  function stop(automatic, message) {
    if (!recording) return;
    recording = false;

    if (controller) {
      try { controller.abort(); } catch (e) { /* ignora */ }
      controller = null;
    }
    clearInterval(tickTimer);
    tickTimer = null;
    setUi(false);

    var elapsed = Date.now() - startedAt;
    log('gravação parada:', formatTime(elapsed), formatSize(totalBytes), message || '');

    if (totalBytes < CONFIG.minBytes) {
      flash(message || 'Gravação muito curta');
      track('radio_record_stop', {
        record_seconds: Math.round(elapsed / 1000),
        record_bytes: totalBytes,
        ended_by: automatic ? 'auto' : 'user',
        discarded: 'curta'
      });
      chunks = [];
      totalBytes = 0;
      return;
    }

    var bytes = assemble();
    download(bytes);
    track('radio_record_stop', {
      record_seconds: Math.round(elapsed / 1000),
      record_bytes: bytes.length,
      file_kb: Math.round(bytes.length / 1024),
      ended_by: automatic ? 'auto' : 'user'
    });

    if (message) flash(message);
    else flash('Salvo: ' + formatTime(elapsed) + ' · ' + formatSize(bytes.length));

    chunks = [];
    totalBytes = 0;
  }

  function beforeUnload(e) {
    if (!recording) return;
    // O navegador mostra o diálogo genérico "sair do site?" (o texto não é nosso)
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  window.addEventListener('beforeunload', beforeUnload);

  /* ------------------------------------------------------------------ */
  /* INICIALIZAÇÃO                                                       */
  /* ------------------------------------------------------------------ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }

  // API pública (testes/automação/atalhos)
  window.sbfiRadioRecorder = {
    start: start,
    stop: function () { stop(false); },
    isRecording: function () { return recording; },
    stats: function () { return { bytes: totalBytes, seconds: recording ? (Date.now() - startedAt) / 1000 : 0, chunks: chunks.length }; },
    config: CONFIG,
  };
})();
