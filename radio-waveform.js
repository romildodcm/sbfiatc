/* ==========================================================================
   RADIO WAVEFORM — visualização do áudio ao vivo
   --------------------------------------------------------------------------
   Porte do WaveformView.kt do app Android (br.tec.io.aviationradio):
   - 48 barras arredondadas, centralizadas verticalmente
   - gradiente que desvanece para baixo
   - parado: animação senoidal de baixa amplitude (passo de 50 ms, como lá)
   - tocando: RMS real do áudio, com suavização 0.3 (antigo) / 0.7 (novo)
     e ganho 3x, iguais aos do Android

   O sinal vem de um AnalyserNode (Web Audio), por isso o <audio> precisa de
   crossorigin="anonymous" — o servidor do stream libera CORS.
   Se o Web Audio não estiver disponível (ou o áudio vier bloqueado), o
   waveform cai na animação parada, sem quebrar o player.

   Uso: <script src="/radio-waveform.js" defer></script>
   ========================================================================== */
(function () {
  'use strict';

  if (window.__sbfiWaveformLoaded) return;
  window.__sbfiWaveformLoaded = true;

  var BAR_COUNT = 48;
  var BAR_RATIO = 1.8;      // largura da barra = largura / (barras * 1.8)
  var GAIN = 3;             // escala do RMS (mesmo fator do Android)
  var MIN_AMPLITUDE = 0.05;
  var IDLE_MS = 50;         // animação parada a ~20 fps
  var SILENCE_LIMIT = 90;   // frames em silêncio antes de reduzir a taxa (~1,5 s)
  var SLOW_MS = 100;        // taxa reduzida enquanto a frequência está quieta
  var PERFECT_LIMIT = 90;   // frames de silêncio absoluto -> grafo mudo (CORS)

  var player = null;
  var canvas = null;
  var g = null;
  var square = null;

  var analyser = null;
  var audioCtx = null;
  var samples = null;

  var amplitudes = new Float32Array(BAR_COUNT);
  var idlePhase = 0;
  var playing = false;      // o <audio> está tocando
  var silentFrames = 0;     // frames seguidos em silêncio (fonia fica muito em silêncio)
  var perfectFrames = 0;    // frames de silêncio absoluto (128 em tudo)
  var blocked = false;      // grafo mudo de verdade: só diagnóstico, não muda o desenho
  var warnedSilent = false;

  var idleTimer = null;
  var rafId = null;
  var slowTimer = null;
  var accent = '#00ff41';

  /* ------------------------------------------------------------------ */
  /* CORES                                                               */
  /* ------------------------------------------------------------------ */
  function readAccent() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--radar-green').trim();
      if (v) accent = v;
    } catch (e) { /* ignora */ }
  }

  function rgba(hex, alpha) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + alpha + ')';
  }

  /* ------------------------------------------------------------------ */
  /* DESENHO                                                             */
  /* ------------------------------------------------------------------ */
  function resize() {
    if (!canvas) return;
    var w = canvas.clientWidth || 0;
    var h = canvas.clientHeight || 0;
    if (!w || !h) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
  }

  function roundRect(x, y, w, h, r) {
    var rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function draw() {
    if (!g || !canvas.width) return;
    var w = canvas.width;
    var h = canvas.height;
    g.clearRect(0, 0, w, h);

    var barW = w / (BAR_COUNT * BAR_RATIO);
    var gap = barW * 0.8;

    // Gradiente do Android: cor cheia no topo, quase transparente embaixo
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, playing ? accent : rgba(accent, 0.4));
    grad.addColorStop(1, rgba(accent, 0.07));
    g.fillStyle = grad;

    for (var i = 0; i < BAR_COUNT; i++) {
      var barH = Math.max(barW, h * amplitudes[i]);
      var x = i * (barW + gap) + gap / 2;
      var y = (h - barH) / 2;
      roundRect(x, y, barW, barH, barW / 2);
      g.fill();
    }
  }

  /* ------------------------------------------------------------------ */
  /* ANIMAÇÃO PARADA (idleRunnable do Android)                           */
  /* ------------------------------------------------------------------ */
  function idleStep() {
    idlePhase += 0.08;
    for (var i = 0; i < BAR_COUNT; i++) {
      amplitudes[i] = 0.08 + 0.06 * Math.sin(i * 0.15 + idlePhase);
    }
    draw();
  }

  function startIdle() {
    stopIdle();
    idleStep();
    idleTimer = setInterval(idleStep, IDLE_MS);
  }

  function stopIdle() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* ÁUDIO REAL                                                          */
  /* ------------------------------------------------------------------ */
  function updateFromAudio() {
    analyser.getByteTimeDomainData(samples);
    var perBar = Math.floor(samples.length / BAR_COUNT) || 1;
    var sawSignal = false;
    var silencioAbsoluto = true;

    for (var i = 0; i < BAR_COUNT; i++) {
      var sum = 0;
      var base = i * perBar;
      for (var j = 0; j < perBar; j++) {
        var raw = samples[base + j];
        if (raw !== 128) silencioAbsoluto = false;
        var s = (raw - 128) / 128;
        sum += s * s;
      }
      var rms = Math.sqrt(sum / perBar);
      if (rms > 0.01) sawSignal = true;
      var amp = Math.min(1, Math.max(MIN_AMPLITUDE, rms * GAIN));
      amplitudes[i] = amplitudes[i] * 0.3 + amp * 0.7;  // suavização do Android
    }

    // Silêncio absoluto (tudo em 128) é outra coisa: indica grafo mudo, não
    // frequência quieta. Serve só de diagnóstico (ex.: CORS do stream).
    if (silencioAbsoluto) {
      if (++perfectFrames > PERFECT_LIMIT && !blocked) {
        blocked = true;
        console.warn('[waveform] Web Audio em silêncio absoluto (a frequência pode estar apenas quieta; se houver áudio audível, verifique o CORS do stream)');
      }
    } else {
      perfectFrames = 0;
      blocked = false;
    }

    return sawSignal;
  }

  function tick() {
    rafId = requestAnimationFrame(function () {
      rafId = null;
      if (!playing || !analyser) return;
      resize();

      if (!updateFromAudio()) {
        if (++silentFrames >= SILENCE_LIMIT) {
          // A fonia passa a maior parte do tempo em silêncio entre as
          // transmissões. Não é falha: apenas baixamos a taxa de atualização
          // sem trocar por animação falsa — o sinal volta quando alguém fala.
          if (!warnedSilent) {
            warnedSilent = true;
            console.info('[waveform] frequência em silêncio (normal em ATC): taxa reduzida');
          }
          startSlowLoop();
          return;
        }
      } else {
        silentFrames = 0;
      }

      draw();
      tick();
    });
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function stopSlowLoop() {
    if (slowTimer) clearInterval(slowTimer);
    slowTimer = null;
  }

  function startSlowLoop() {
    stopLoop();
    stopSlowLoop();
    slowTimer = setInterval(function () {
      if (!playing || !analyser) { stopSlowLoop(); return; }
      resize();
      if (updateFromAudio()) {
        // Voltou fonia: retoma a animação fluida
        silentFrames = 0;
        stopSlowLoop();
        tick();
        return;
      }
      draw();
    }, SLOW_MS);
  }

  function startLoop() {
    stopIdle();
    stopLoop();
    stopSlowLoop();
    if (!analyser) { startIdle(); return; }
    tick();
  }

  function onPlaying() {
    silentFrames = 0;
    playing = true;
    if (square) square.classList.add('playing');
    startLoop();
  }

  function onPaused() {
    playing = false;
    if (square) square.classList.remove('playing');
    stopLoop();
    stopSlowLoop();
    startIdle();
  }

  /* ------------------------------------------------------------------ */
  /* WEB AUDIO                                                           */
  /* ------------------------------------------------------------------ */
  function resumeCtx() {
    try {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* ignora */ }
  }

  function ensureContext() {
    if (audioCtx) { resumeCtx(); return true; }
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      audioCtx = new Ctx();
      resumeCtx();
      return true;
    } catch (e) {
      audioCtx = null;
      return false;
    }
  }

  // IMPORTANTE: criar o nó de mídia só DEPOIS que o áudio começa a tocar.
  // Criá-lo antes do player chamar load() faz o grafo entregar silêncio.
  function ensureGraph() {
    if (analyser) { resumeCtx(); return true; }
    if (!ensureContext()) return false;
    resumeCtx();
    // Contexto suspenso engole o som do elemento (o grafo passa a ser o único
    // destino do áudio). Só cria o nó com o contexto rodando de verdade: no
    // autoplay o contexto pode nascer suspenso e o gesto é quem destrava
    // (ver retryGraph no init), em vez de deixar a fonia muda.
    if (audioCtx.state !== 'running') return false;
    try {
      var source = audioCtx.createMediaElementSource(player);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      samples = new Uint8Array(analyser.fftSize);

      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      resumeCtx();
      return true;
    } catch (e) {
      analyser = null;
      console.warn('[waveform] Web Audio indisponível:', e && e.message);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* INICIALIZAÇÃO                                                       */
  /* ------------------------------------------------------------------ */
  function init() {
    player = document.getElementById('radioPlayer');
    canvas = document.getElementById('waveformCanvas');
    square = document.getElementById('playerSquare');
    if (!player || !canvas) return;

    g = canvas.getContext('2d');
    if (!g) return;

    readAccent();
    resize();
    startIdle();

    // O contexto nasce dentro do gesto do usuário (política de áudio);
    // o nó de mídia é criado depois, quando o áudio realmente começa.
    var playBtn = document.getElementById('playButton');
    if (playBtn) {
      playBtn.addEventListener('click', function () { ensureContext(); }, true);
    }

    // O elemento nasce `muted` por causa da política de autoplay. O nó de mídia
    // precisa ser criado com o áudio já audível: criado enquanto `muted`, o
    // grafo entrega silêncio para sempre.
    function startGraph() {
      if (player.muted) player.muted = false;
      var ok = ensureGraph();
      onPlaying();
      return ok;
    }

    // O autoplay pode ter começado a tocar antes de o contexto de áudio poder
    // rodar (ex.: Safari com auto-play liberado). O grafo não foi criado para
    // não mutar a fonia; o primeiro gesto tenta criar de novo.
    function retryGraph() {
      if (analyser || !player || player.paused) return;
      if (!startGraph() && audioCtx) {
        audioCtx.resume().then(retryGraph, function () { /* ignora */ });
      }
    }

    ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, retryGraph, true);
    });

    player.addEventListener('playing', startGraph);
    player.addEventListener('play', startGraph);
    player.addEventListener('pause', onPaused);
    player.addEventListener('ended', onPaused);

    window.addEventListener('resize', function () { resize(); });

    // Re-lê a cor de acento quando o tema muda (verde <-> vermelho)
    try {
      new MutationObserver(function () {
        readAccent();
        if (!playing) idleStep();
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { /* ignora */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // API pública (testes/depuração)
  window.sbfiWaveform = {
    isLive: function () { return !!analyser && playing; },
    amplitudes: function () { return Array.prototype.slice.call(amplitudes); },
    redraw: function () { resize(); draw(); },
    state: function () {
      return {
        contexto: audioCtx ? audioCtx.state : 'ausente',
        temAnalyser: !!analyser,
        tocando: playing,
        grafoMudo: blocked,
        framesEmSilencio: silentFrames,
        muted: player ? player.muted : null,
        volume: player ? player.volume : null
      };
    }
  };
})();
