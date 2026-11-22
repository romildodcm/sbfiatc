/* ==========================================================================
   keep-awake.js — a tela não apaga enquanto o site está aberto
   --------------------------------------------------------------------------
   Por que existe: em TV/navegador de TV (Fire Stick, caixinha Android TV,
   Silk) a economia de energia entendia "página SEM VÍDEO tocando" e deixava
   a tela apagar depois de alguns minutos, mesmo com a fonia ao vivo tocando
   — áudio puro não conta como mídia em reprodução para esses aparelhos.

   Faz duas coisas, em camadas (nenhuma atrapalha a outra):

   1. Screen Wake Lock API (navigator.wakeLock) — o pedido oficial para o
      sistema não apagar nem bloquear a tela. Funciona no Chrome/Edge/
      Firefox/Brave atuais. O lock é liberado pelo navegador sempre que a
      aba some; por isso volta a ser pedido no visibilitychange e a cada
      poucos segundos (pedir com o lock já ativo é no-op).

   2. Vídeo mudo invisível em loop (8×8 px, 2 s, ~1,6 KB) — a camada de
      reserva para o navegador ANTIGO do Fire Stick, que não tem a API e só
      olha para o <video>/<audio> da página. Como o vídeo está sempre "tocando", ele entra
      no caso "vídeo em play" (o mesmo que segura a tela no YouTube). Se o
      navegador exigir um toque para liberar o vídeo, ele destrava no primeiro
      gesto e continua tentando sozinho a cada 30 s.

   Uso: o próprio script se liga sozinho em qualquer página que o inclua.

     <script src="/keep-awake.js" defer></script>

   Para desligar (ex.: outro teste):

     window.sbfiKeepAwake.disable();

   O vídeo é pequeno e vai no cache do service worker (ver sw.js): funciona
   offline e custa ~1,6 KB. Nada aparece na tela e o áudio do site continua
   saindo normal.
   ========================================================================== */
(function () {
  'use strict';

  var SRC = '/keep-awake.mp4';
  var MUTE_SRC = '/keep-awake-mute.mp4';   // reserva para o NÃO mudo (iOS)
  var LOOP_SRC = '/keep-awake-loop.mp4';   // reserva para o loop (navegador velho)
  var CHECK_MS = 5000;
  var RETRY_MS = 30000;

  var TIPOS = [
    'video/mp4; codecs="avc1.42E01E"',
    'video/mp4'
  ];

  var api = {
    ligado: false,
    rotulo: 'nenhum',      // wake lock | video-mudo | video-intermitente | nenhum
    erro: '',
    estado: estado
  };
  window.sbfiKeepAwake = api;

  /* Ligado/desligado ficam em ponteiros preenchidos mais abaixo (os dois usam
     coisas declaradas depois daqui). Assim a API pública já existe quando o
     script termina de carregar, mesmo que algo falhe no meio. */
  api.enable = function () { return ligar(); };
  api.disable = function () { return desligar(); };

  /* -------------------------------------------------------------------- */
  /* CAMADA 1 — Screen Wake Lock API                                      */
  /* -------------------------------------------------------------------- */

  var wakeLock = null;
  var wakeLockPedido = false;

  function temWakeLock() {
    return !!(navigator.wakeLock && typeof navigator.wakeLock.request === 'function');
  }

  function pedirWakeLock() {
    if (!temWakeLock() || wakeLockPedido) return;
    if (document.visibilityState !== 'visible') return;

    wakeLockPedido = true;
    try {
      navigator.wakeLock.request('screen').then(function (sentinel) {
        wakeLockPedido = false;
        wakeLock = sentinel;

        // O sistema/navegador pode liberar o lock sozinho (aba em segundo
        // plano, economia de energia agressiva). Avisa e tenta de novo.
        sentinel.addEventListener('release', function () {
          if (wakeLock === sentinel) wakeLock = null;
        });
      }, function (err) {
        /* NotAllowedError sem gesto do usuário, ou aparelho sem suporte real.
           A camada 2 (vídeo) cobre esse caso. */
        wakeLockPedido = false;
        api.erro = (err && err.name) || 'wake-lock-recusado';
      });
    } catch (e) {
      wakeLockPedido = false;
      api.erro = (e && e.name) || 'wake-lock-falhou';
    }
  }

  /* -------------------------------------------------------------------- */
  /* CAMADA 2 — vídeo mudo invisível em loop                              */
  /* -------------------------------------------------------------------- */

  var video = null;
  var tentativas = 0;

  /* Três tentativas, do mais leve ao mais tolerante:
       1. keep-awake.mp4       — o caso normal;
       2. keep-awake-mute.mp4  — mesmo vídeo, para navegador que recusa o
                                 atributo "muted";
       3. keep-awake-loop.mp4  — mesmo vídeo, para navegador que recusa o
                                 atributo "loop" (o sw.js responde com o
                                 Content-Type de MP4 mesmo sem MIME no host). */
  function tentarFonte() {
    if (!video) return;

    var base = tentativas === 0 ? SRC : (tentativas === 1 ? MUTE_SRC : LOOP_SRC);
    var t = TIPOS[Math.min(tentativas, TIPOS.length - 1)];

    // ?w= evita que um cache antigo devolva de novo a variante que falhou
    video.src = base + '?w=' + tentativas;
    var fonte = video.querySelector('source');
    if (fonte) fonte.setAttribute('type', t);

    var p = video.play();
    if (p && p.catch) {
      p.catch(function () {
        /* AbortError = outro load() cancelou este play(): não é falha */
      });
    }
  }

  function criarVideo() {
    if (video) return video;

    video = document.createElement('video');
    video.id = 'keepAwakeVideo';
    video.loop = true;
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.setAttribute('tabindex', '-1');

    /* 8 × 8 px reais (o arquivo já é 8×8): o navegador decodifica quase nada,
       mas o elemento continua "no documento e visível" para quem decide se a
       mídia está em reprodução. */
    video.style.cssText =
      'position:fixed;left:0;bottom:0;width:8px;height:8px;' +
      'opacity:0.01;pointer-events:none;z-index:-1;background:#000;';

    var fonte = document.createElement('source');
    fonte.type = TIPOS[0];
    video.appendChild(fonte);

    document.body.appendChild(video);

    video.addEventListener('playing', function () {
      api.rotulo = video.muted ? 'video-mudo' : 'video-intermitente';
    });

    video.addEventListener('error', function () {
      tentativas += 1;
      if (tentativas < 3) {
        tentarFonte();
        return;
      }
      api.rotulo = 'nenhum';
      api.erro = 'video-indisponivel';
    });

    tentarFonte();
    return video;
  }

  /* Tenta tocar o vídeo. Se o navegador bloquear (política de autoplay de
     navegador de TV velho, que exige um toque), tenta de novo quando o
     usuário tocar em qualquer lugar — o mesmo toque do play da fonia — e
     também sozinho, a cada RETRY_MS: alguns navegadores de TV liberam depois
     do primeiro toque na página, mesmo que já passado. */
  var retryTimer = null;
  var gestosArmados = false;

  function destravar() {
    if (!video) return;
    var p = video.play();
    if (!p || !p.then) return;

    p.then(function () {
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      if (gestosArmados) {
        gestosArmados = false;
        ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
          document.removeEventListener(ev, destravar, true);
        });
      }
    }, function () {
      if (gestosArmados) return;
      gestosArmados = true;
      ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
        document.addEventListener(ev, destravar, true);
      });
      if (!retryTimer) retryTimer = setInterval(destravar, RETRY_MS);
    });
  }

  var semDadosMs = 0;

  function tocarVideo() {
    if (!video) return;

    /* Navegador velho "trava" a mídia com o tempo e fica recarregando, preso
       em readyState 1 (sem quadro). Se isso durar ~15 s, troca a fonte: é a
       troca que o reinicia de verdade (pause() sozinho não resolve). */
    if (!video.paused && video.readyState < 2 && !video.seeking) {
      if (video.currentTime > 0) return;     // andou: está decodificando
      semDadosMs += CHECK_MS;
      if (semDadosMs < 15000) return;
    }
    semDadosMs = 0;

    var p = video.play();
    if (p && p.catch) {
      p.catch(function (err) {
        if (err && err.name === 'AbortError') return;  // outro load() cancelou
        destravar();
      });
    }
  }

  /* -------------------------------------------------------------------- */
  /* MANTÉM TUDO VIVO                                                     */
  /* -------------------------------------------------------------------- */

  var timer = null;

  function verificar() {
    if (!api.ligado) return;

    pedirWakeLock();

    if (video) {
      if (video.ended || video.paused) tocarVideo();
    } else {
      criarVideo();
    }

    api.rotulo = wakeLock ? 'wake lock' : (video && !video.paused ? (video.muted ? 'video-mudo' : 'video-intermitente') : 'nenhum');
  }

  function onVisible() {
    if (document.visibilityState === 'visible') verificar();
  }

  function ligar() {
    if (api.ligado) return api;
    if (!document.body) {
      // chamado antes do <body> existir (script no <head>): espera o DOM
      document.addEventListener('DOMContentLoaded', ligar, { once: true });
      return api;
    }

    api.ligado = true;
    api.erro = '';
    verificar();

    if (!timer) timer = setInterval(verificar, CHECK_MS);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', verificar);
    window.addEventListener('pageshow', verificar);

    return api;
  }

  function desligar() {
    api.ligado = false;

    if (timer) { clearInterval(timer); timer = null; }
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', verificar);
    window.removeEventListener('pageshow', verificar);

    if (wakeLock) {
      try { wakeLock.release(); } catch (e) { /* ignora */ }
      wakeLock = null;
    }
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    if (gestosArmados) {
      gestosArmados = false;
      ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
        document.removeEventListener(ev, destravar, true);
      });
    }
    if (video) {
      try { video.pause(); } catch (e) { /* ignora */ }
    }
    api.rotulo = 'nenhum';
    return api;
  }

  function estado() {
    return {
      ligado: api.ligado,
      camada: api.rotulo,
      wakeLockAtivo: !!wakeLock,
      wakeLockSuportado: temWakeLock(),
      videoTocando: !!(video && !video.paused && !video.ended),
      autoplayBloqueado: gestosArmados,
      erro: api.erro
    };
  }

  /* Liga sozinho: a página inteira é para ficar na tela sem interação. */
  ligar();
})();
