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

   PRÉ-ROLL: o Icecast não devolve áudio antigo — o máximo que ele entrega de
   saída é o "burst" inicial (64 KB, ~16 s). Para a gravação incluir o que
   motivou o clique, o módulo mantém essa conexão viva enquanto a página toca
   e guarda os bytes crus numa memória circular com os últimos
   preRollMinutes. Ao clicar em gravar, o conteúdo do buffer entra como
   começo do arquivo e a captura segue ao vivo até parar.
   Como o stream é CBR, bytes são um relógio confiável: a 32 kbps, 2 minutos
   ocupam ~480 KB de memória — nada para o navegador.

   Independe do player para gravar, mas o buffer só liga quando o áudio toca
   (quem só abre a página não abre conexão extra no servidor).

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
    maxMinutes: 240,        // trava de segurança (~14 MB por hora, em 32 kbps)
    minBytes: 4096,         // abaixo disso foi curto demais (~1s) para valer arquivo
    retryDelayMs: 2000,     // espera entre tentativas se a conexão cair
    maxRetries: 5,
    // Quanto do que já tocou entra na gravação (o "pré-roll")
    preRollMinutes: 2,
    bytesPerSecond: 4096,    // 32 kbps -> 4 KB/s: é o relógio do buffer circular
    maxBufferBytes: 2097152, // teto de segurança se o stream subir de bitrate
    debug: /[?&]radio_rec_debug=1/.test(window.location.search),
  }, window.SBFI_RADIO_RECORDER || {});

  var LABEL_IDLE = 'Gravar Fonia ATC';
  var LABEL_RECORDING = 'Gravando Fonia ATC';

  var btn = null;
  var label = null;
  var counter = null;
  var player = null;
  var recording = false;
  var chunks = [];              // arquivo em construção (pré-roll + ao vivo)
  var totalBytes = 0;
  var startedAt = 0;
  var tickTimer = null;
  var msgTimer = null;
  var pauseTimer = null;
  var failures = 0;

  // Buffer circular do pré-roll: só existe enquanto a página toca
  var buffer = [];              // pedaços de MP3, do mais antigo ao mais novo
  var bufferBytes = 0;
  var buffering = false;        // o player está tocando?
  var collecting = false;       // a conexão de coleta está de pé?
  var collectController = null;
  var preRollBytesIncluded = 0; // quanto de pré-roll entrou na gravação atual

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
  /* PRÉ-ROLL: MEMÓRIA CIRCULAR DO QUE JÁ TOCOU                          */
  /* ------------------------------------------------------------------ */
  function msOf(bytes) {
    return Math.round(bytes / CONFIG.bytesPerSecond * 1000);
  }

  function preRollLimit() {
    return Math.round(CONFIG.preRollMinutes * 60 * CONFIG.bytesPerSecond);
  }

  // Joga fora o mais antigo até caber na janela (e até o teto de segurança)
  function trimBuffer() {
    var limite = preRollLimit();
    while (buffer.length > 1 && (bufferBytes > limite || bufferBytes > CONFIG.maxBufferBytes)) {
      bufferBytes -= buffer[0].length;
      buffer.shift();
    }
  }

  function clearBuffer() {
    buffer = [];
    bufferBytes = 0;
  }

  function bufferState() {
    return {
      collecting: collecting,
      buffering: buffering,
      bytes: bufferBytes,
      seconds: Math.round(msOf(bufferBytes) / 1000),
      targetSeconds: CONFIG.preRollMinutes * 60,
    };
  }

  // Cada pedaço que chega vai para o buffer circular e, se houver gravação
  // em andamento, também para o arquivo.
  function feed(bytes) {
    if (!bytes || !bytes.length) return;
    buffer.push(bytes);
    bufferBytes += bytes.length;
    trimBuffer();
    if (recording) {
      chunks.push(bytes);
      totalBytes += bytes.length;
    }
    failures = 0;
  }

  /* ------------------------------------------------------------------ */
  /* COLETOR: UMA CONEXÃO QUE ALIMENTA O BUFFER E A GRAVAÇÃO             */
  /* ------------------------------------------------------------------ */
  async function drain(signal) {
    var res = await fetch(streamUrl(), { mode: 'cors', cache: 'no-store', signal: signal });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status + ' sem corpo');

    var reader = res.body.getReader();
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      feed(r.value);
    }
  }

  async function run(signal) {
    while (collecting) {
      try {
        await drain(signal);
      } catch (e) {
        if (!collecting || (e && e.name === 'AbortError')) return;
        failures += 1;
        log('falha na conexão (' + failures + '/' + CONFIG.maxRetries + '):', e.message);
        if (failures > CONFIG.maxRetries) {
          // Gravar sem conexão não faz sentido; o buffer é conveniência
          if (recording) stop(true, 'A conexão caiu e não voltou');
          else { log('desistindo do buffer após ' + failures + ' falhas'); stopCollector(); }
          return;
        }
        await delay(CONFIG.retryDelayMs * failures);
        continue;
      }
      // O stream terminou sozinho: se ainda precisamos dele, reconecta
      if (!collecting) return;
      await delay(500);
    }
  }

  // O coletor fica de pé enquanto o player toca ou enquanto há gravação
  function updateCollector() {
    var need = recording || buffering;
    if (need && !collecting) startCollector();
    else if (!need && collecting) stopCollector();
  }

  function startCollector() {
    if (collecting) return;
    collecting = true;
    failures = 0;
    collectController = new AbortController();
    log('coletor ligado');
    run(collectController.signal);
  }

  function stopCollector() {
    if (!collecting) return;
    collecting = false;
    if (collectController) {
      try { collectController.abort(); } catch (e) { /* ignora */ }
      collectController = null;
    }
    log('coletor desligado');
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
    setupPlayer();
    log('gravador pronto');
  }

  /* ------------------------------------------------------------------ */
  /* PLAYER: É ELE QUE DIZ QUANDO O BUFFER DEVE ESTAR LIGADO             */
  /* ------------------------------------------------------------------ */
  function setupPlayer() {
    player = document.getElementById('radioPlayer');
    if (!player) {
      log('sem #radioPlayer na página: pré-roll desligado (gravar segue funcionando)');
      return;
    }
    player.addEventListener('playing', onPlayerPlaying);
    player.addEventListener('pause', onPlayerPaused);
    if (!player.paused) onPlayerPlaying();   // já tocava quando o script carregou
  }

  function onPlayerPlaying() {
    clearTimeout(pauseTimer);
    if (buffering) return;
    buffering = true;
    log('player tocando: buffer de pré-roll ligado');
    updateCollector();
  }

  // O player se reconecta sozinho e pode disparar "pause" no meio da
  // reprodução. Só desligamos o buffer se ele seguir parado depois de um tempo.
  function onPlayerPaused() {
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(function () {
      if (player && !player.paused) return;
      if (!buffering) return;
      buffering = false;
      clearBuffer();   // pausa longa: o passado guardado não serve mais
      log('player parado: buffer de pré-roll desligado');
      updateCollector();
    }, 1500);
  }

  function setLabel(text) {
    if (label) label.textContent = text;
  }

  function setUi(state) {
    if (!btn) return;
    btn.classList.toggle('recording', state);
    // Sem title: quem explica o botão é o tooltip estilizado (.record-tip)
    btn.setAttribute('aria-label', state ? 'Parar gravação e baixar o MP3' : 'Gravar fonia (MP3)');
    setLabel(state ? LABEL_RECORDING : LABEL_IDLE);
    if (label) label.classList.remove('warn');
    if (counter) counter.textContent = '';
  }

  // O contador mostra o tempo TOTAL do arquivo, não só o que falta gravar: o
  // pré-roll já entra na conta desde o primeiro segundo, que é exatamente o
  // que o arquivo vai ter quando for baixado.
  function tick() {
    if (!recording || !counter) return;
    var elapsed = Date.now() - startedAt;
    counter.textContent = formatTime(elapsed + msOf(preRollBytesIncluded));
    if (elapsed > CONFIG.maxMinutes * 60000) stop(true, 'Limite de ' + CONFIG.maxMinutes + ' min atingido');
  }

  // Mostra o resultado por alguns segundos no próprio rótulo da faixa
  function flash(message, ms) {
    if (!label) return;
    clearTimeout(msgTimer);
    setLabel(message);
    label.classList.add('warn');
    msgTimer = setTimeout(function () {
      label.classList.remove('warn');
      // Durante a gravação o rótulo precisa voltar para "Gravando"
      setLabel(recording ? LABEL_RECORDING : LABEL_IDLE);
    }, ms || 4000);
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

    // O que já está no buffer entra como começo do arquivo: é justamente o
    // trecho que motivou o clique. Menos que uns poucos frames não vale nada.
    var seed = buffer.slice();
    var seedBytes = bufferBytes;
    if (seedBytes < 512) { seed = []; seedBytes = 0; }

    recording = true;
    chunks = seed;
    totalBytes = seedBytes;
    preRollBytesIncluded = seedBytes;
    failures = 0;
    startedAt = Date.now();

    setUi(true);
    tick();
    tickTimer = setInterval(tick, 1000);
    updateCollector();   // garante o coletor mesmo com o player parado
    log('gravação iniciada' +
      (preRollBytesIncluded ? ' com ' + formatTime(msOf(preRollBytesIncluded)) + ' de pré-roll' : ''));
    track('radio_record_start', {
      trigger: 'button',
      pre_roll_seconds: Math.round(msOf(preRollBytesIncluded) / 1000)
    });

    // Avisa na própria faixa que o passado entrou (no celular não existe hover,
    // então o tooltip sozinho não daria conta)
    if (preRollBytesIncluded > 3 * CONFIG.bytesPerSecond) {
      flash('Inclui ' + formatTime(msOf(preRollBytesIncluded)) + ' anteriores', 3500);
    }
  }

  function stop(automatic, message) {
    if (!recording) return;
    recording = false;

    clearInterval(tickTimer);
    tickTimer = null;
    setUi(false);
    updateCollector();   // acabou a gravação: o coletor só fica se o player toca

    var elapsed = Date.now() - startedAt;
    var totalMs = elapsed + msOf(preRollBytesIncluded);
    log('gravação parada:', formatTime(elapsed), formatSize(totalBytes),
      preRollBytesIncluded ? 'pré-roll ' + formatTime(msOf(preRollBytesIncluded)) : '',
      message || '');

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
      preRollBytesIncluded = 0;
      return;
    }

    var bytes = assemble();
    download(bytes);
    track('radio_record_stop', {
      record_seconds: Math.round(elapsed / 1000),
      pre_roll_seconds: Math.round(msOf(preRollBytesIncluded) / 1000),
      file_seconds: Math.round(totalMs / 1000),
      record_bytes: bytes.length,
      file_kb: Math.round(bytes.length / 1024),
      ended_by: automatic ? 'auto' : 'user'
    });

    if (message) flash(message);
    else flash('Salvo: ' + formatTime(totalMs) + ' · ' + formatSize(bytes.length));

    chunks = [];
    totalBytes = 0;
    preRollBytesIncluded = 0;
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
    stats: function () {
      return {
        bytes: totalBytes,
        seconds: recording ? (Date.now() - startedAt) / 1000 : 0,
        chunks: chunks.length,
        preRollBytes: preRollBytesIncluded,
        preRollSeconds: Math.round(msOf(preRollBytesIncluded) / 1000)
      };
    },
    buffer: bufferState,
    config: CONFIG,
  };
})();
