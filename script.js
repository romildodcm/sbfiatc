// Controles do player de rádio
// Event listeners para o player
document.addEventListener('DOMContentLoaded', function() {
    const player = document.getElementById('radioPlayer');
    const status = document.getElementById('status');

    function setStatus(text, className) {
        status.textContent = text;
        status.classList.remove('status-playing', 'status-connecting', 'status-error');
        if (className) status.classList.add(className);
    }

    // Status inicial - pedir para clicar em play
    setStatus('Clique em ▶️ para ouvir');

    player.addEventListener('loadstart', () => {
        setStatus('Conectando...', 'status-connecting');
    });

    player.addEventListener('play', () => {
        setStatus('Reproduzindo', 'status-playing');
    });

    player.addEventListener('pause', () => {
        setStatus('Clique em ▶️ para ouvir');
    });

    player.addEventListener('canplay', () => {
        if (!player.paused) {
            setStatus('Reproduzindo', 'status-playing');
        }
    });

    player.addEventListener('error', () => {
        setStatus('Erro na conexão', 'status-error');
    });

    player.addEventListener('ended', () => {
        setStatus('Clique em ▶️ para ouvir');
    });
});
