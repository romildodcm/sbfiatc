// Controles do player de rádio com Material Web Components - Versão Simplificada
document.addEventListener('DOMContentLoaded', function() {
    const player = document.getElementById('radioPlayer');
    const status = document.getElementById('status');
    const playButton = document.getElementById('playButton');
    const volumeButton = document.getElementById('volumeButton');
    const volumeSlider = document.getElementById('volumeSlider');
    const connectionProgress = document.getElementById('connectionProgress');
    const audioCard = document.querySelector('.audio-card');

    let isPlaying = false;
    let isMuted = false;
    let previousVolume = 1.0;

    // Função para atualizar o status
    function setStatus(text, className) {
        status.textContent = text;
        status.classList.remove('status-playing', 'status-connecting', 'status-error');
        if (className) status.classList.add(className);
    }

    // Função para atualizar o estado visual do player
    function updatePlayerState(state) {
        audioCard.classList.remove('player-playing', 'player-connecting', 'player-error');
        if (state) audioCard.classList.add(`player-${state}`);
    }

    // Função para atualizar o ícone do botão play
    function updatePlayButton() {
        const icon = playButton.querySelector('md-icon');
        icon.textContent = isPlaying ? 'pause' : 'play_arrow';
    }

    // Função para atualizar o ícone do volume
    function updateVolumeIcon() {
        const icon = volumeButton.querySelector('md-icon');
        if (isMuted || player.volume === 0) {
            icon.textContent = 'volume_off';
        } else if (player.volume < 0.5) {
            icon.textContent = 'volume_down';
        } else {
            icon.textContent = 'volume_up';
        }
    }

    // Status inicial
    setStatus('Sistema disponível');
    updatePlayerState();

    // Controle do botão play/pause
    playButton.addEventListener('click', function() {
        if (player.paused) {
            connectionProgress.style.display = 'block';
            updatePlayerState('connecting');
            setStatus('Estabelecendo conexão...', 'status-connecting');

            player.play().catch(error => {
                console.error('Erro ao reproduzir:', error);
                setStatus('Falha na conexão', 'status-error');
                updatePlayerState('error');
                connectionProgress.style.display = 'none';
                isPlaying = false;
                updatePlayButton();
            });
        } else {
            player.pause();
        }
    });

    // Controle do volume
    volumeButton.addEventListener('click', function() {
        if (isMuted) {
            player.volume = previousVolume;
            volumeSlider.value = previousVolume * 100;
            isMuted = false;
        } else {
            previousVolume = player.volume;
            player.volume = 0;
            volumeSlider.value = 0;
            isMuted = true;
        }
        updateVolumeIcon();
    });

    volumeSlider.addEventListener('input', function() {
        const volume = this.value / 100;
        player.volume = volume;
        isMuted = volume === 0;
        if (volume > 0) {
            previousVolume = volume;
        }
        updateVolumeIcon();
    });

    // Event listeners para o player
    player.addEventListener('loadstart', () => {
        connectionProgress.style.display = 'block';
        updatePlayerState('connecting');
        setStatus('', 'status-connecting');
    });

    player.addEventListener('play', () => {
        isPlaying = true;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState('playing');
        setStatus('AO VIVO', 'status-playing');
        volumeSlider.disabled = false;
    });

    player.addEventListener('pause', () => {
        isPlaying = false;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState();
        setStatus('Sistema disponível');
        volumeSlider.disabled = true;
    });

    player.addEventListener('canplay', () => {
        connectionProgress.style.display = 'none';
        if (!player.paused) {
            updatePlayerState('playing');
            setStatus('AO VIVO', 'status-playing');
        }
    });

    player.addEventListener('error', () => {
        isPlaying = false;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState('error');
        setStatus('Falha na conexão', 'status-error');
        volumeSlider.disabled = true;
    });

    player.addEventListener('ended', () => {
        isPlaying = false;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState();
        setStatus('Transmissão finalizada');
        volumeSlider.disabled = true;
    });

    player.addEventListener('volumechange', () => {
        updateVolumeIcon();
    });

    // Inicializar volume
    player.volume = 1.0;
    volumeSlider.value = 100;
    updateVolumeIcon();
});
