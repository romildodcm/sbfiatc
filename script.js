// Controles do player de rádio com Material Web Components - Versão Otimizada para Baixa Latência
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
    let streamUrl = 'https://ic.io.tec.br/sbfi';

    // Configurações para baixa latência
    function configurePlayerForLowLatency() {
        // Configurar atributos para baixa latência
        player.setAttribute('preload', 'none');
        player.setAttribute('autoplay', 'false');
        
        // Configurações específicas para reduzir buffering
        if (player.webkitAudioDecodedByteCount !== undefined) {
            // Safari specific optimizations
            player.preload = 'none';
        }
        
        // Reduzir buffer para menor latência
        try {
            if (player.buffered && player.buffered.length > 0) {
                // Força o player a não fazer buffer excessivo
                player.currentTime = player.buffered.end(player.buffered.length - 1);
            }
        } catch (e) {
            // Ignora erros de buffer quando stream não está carregado
        }
    }

    // Função para gerar URL com timestamp anti-cache
    function getStreamUrl() {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(7);
        return `${streamUrl}?t=${timestamp}&r=${random}&nocache=1`;
    }

    // Função para recarregar o stream com nova URL
    function reloadStream() {
        const newUrl = getStreamUrl();
        const source = player.querySelector('source');
        source.src = newUrl;
        player.load();
        console.log('Stream recarregado com URL:', newUrl);
    }

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
    configurePlayerForLowLatency();

    // Controle do botão play/pause
    playButton.addEventListener('click', function() {
        if (player.paused) {
            connectionProgress.style.display = 'block';
            updatePlayerState('connecting');
            setStatus('Estabelecendo conexão...', 'status-connecting');

            // Recarregar stream com URL anti-cache antes de reproduzir
            reloadStream();
            
            // Aguardar um pouco para o stream carregar e então reproduzir
            setTimeout(() => {
                player.play().then(() => {
                    // Sucesso na reprodução
                    console.log('Reprodução iniciada com sucesso');
                }).catch(error => {
                    console.error('Erro ao reproduzir:', error);
                    setStatus('Falha na conexão', 'status-error');
                    updatePlayerState('error');
                    connectionProgress.style.display = 'none';
                    isPlaying = false;
                    updatePlayButton();
                });
            }, 100);
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

    // Event listeners para o player otimizados para baixa latência
    player.addEventListener('loadstart', () => {
        connectionProgress.style.display = 'block';
        updatePlayerState('connecting');
        setStatus('Carregando stream...', 'status-connecting');
        console.log('Iniciando carregamento do stream');
    });

    player.addEventListener('loadeddata', () => {
        console.log('Dados do stream carregados');
        configurePlayerForLowLatency();
    });

    player.addEventListener('canplay', () => {
        connectionProgress.style.display = 'none';
        if (!player.paused) {
            updatePlayerState('playing');
            setStatus('AO VIVO', 'status-playing');
        }
        console.log('Stream pronto para reprodução');
        
        // Otimização: tentar minimizar o buffer
        try {
            if (player.buffered.length > 0) {
                const bufferedEnd = player.buffered.end(player.buffered.length - 1);
                const bufferedStart = player.buffered.start(0);
                const bufferSize = bufferedEnd - bufferedStart;
                console.log(`Buffer size: ${bufferSize.toFixed(2)}s`);
                
                // Se o buffer for muito grande, tentar avançar para reduzir latência
                if (bufferSize > 3) {
                    player.currentTime = bufferedEnd - 1;
                    console.log('Buffer reduzido para minimizar latência');
                }
            }
        } catch (e) {
            // Ignora erros de buffer
        }
    });

    player.addEventListener('play', () => {
        isPlaying = true;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState('playing');
        setStatus('AO VIVO', 'status-playing');
        volumeSlider.disabled = false;
        console.log('Reprodução iniciada');
        
        // Desmutar se necessário (para contornar políticas de autoplay)
        if (player.muted) {
            player.muted = false;
        }
    });

    player.addEventListener('waiting', () => {
        console.log('Aguardando dados do stream...');
        updatePlayerState('connecting');
        setStatus('Aguardando dados...', 'status-connecting');
        connectionProgress.style.display = 'block';
    });

    player.addEventListener('stalled', () => {
        console.log('Stream travou, tentando reconectar...');
        updatePlayerState('connecting');
        setStatus('Reconectando...', 'status-connecting');
        connectionProgress.style.display = 'block';
        
        // Tentar recarregar o stream após 2 segundos
        setTimeout(() => {
            if (player.networkState === player.NETWORK_LOADING || player.networkState === player.NETWORK_NO_SOURCE) {
                console.log('Recarregando stream devido a travamento');
                reloadStream();
            }
        }, 2000);
    });

    player.addEventListener('pause', () => {
        isPlaying = false;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState();
        setStatus('Sistema disponível');
        volumeSlider.disabled = true;
        console.log('Reprodução pausada');
    });

    player.addEventListener('error', (e) => {
        isPlaying = false;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState('error');
        setStatus('Falha na conexão', 'status-error');
        volumeSlider.disabled = true;
        
        console.error('Erro no player:', e);
        console.error('Código do erro:', player.error ? player.error.code : 'Desconhecido');
        
        // Tentar reconectar após 3 segundos
        setTimeout(() => {
            console.log('Tentando reconectar automaticamente...');
            reloadStream();
        }, 3000);
    });

    player.addEventListener('ended', () => {
        isPlaying = false;
        updatePlayButton();
        connectionProgress.style.display = 'none';
        updatePlayerState();
        setStatus('Transmissão finalizada');
        volumeSlider.disabled = true;
        console.log('Stream finalizado');
    });

    player.addEventListener('volumechange', () => {
        updateVolumeIcon();
    });

    // Monitoramento de qualidade da conexão
    setInterval(() => {
        if (isPlaying) {
            try {
                if (player.buffered.length > 0) {
                    const currentTime = player.currentTime;
                    const bufferedEnd = player.buffered.end(player.buffered.length - 1);
                    const bufferHealth = bufferedEnd - currentTime;
                    
                    // Log para debug
                    if (bufferHealth < 0.5) {
                        console.warn(`Buffer baixo: ${bufferHealth.toFixed(2)}s`);
                    }
                    
                    // Se o buffer estiver muito alto, tentar reduzir latência
                    if (bufferHealth > 5) {
                        console.log('Reduzindo latência - avançando no buffer');
                        player.currentTime = bufferedEnd - 1;
                    }
                }
            } catch (e) {
                // Ignora erros de buffer durante monitoramento
            }
        }
    }, 5000); // Verifica a cada 5 segundos

    // Inicializar volume
    player.volume = 1.0;
    volumeSlider.value = 100;
    updateVolumeIcon();

    // Configuração inicial
    console.log('Player inicializado com configurações de baixa latência');
    
    // Registrar Service Worker para controle de cache
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then((registration) => {
                console.log('Service Worker registrado com sucesso:', registration.scope);
            })
            .catch((error) => {
                console.log('Falha ao registrar Service Worker:', error);
            });
    }

    // ========================================
    // MODAL ADICIONAR À TELA INICIAL
    // ========================================
    
    const addToHomeModal = document.getElementById('addToHomeModal');
    const closeAddToHomeModal = document.getElementById('closeAddToHomeModal');
    
    // Verificar se é um dispositivo móvel
    function isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }
    
    // Verificar se já está instalado como PWA
    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches || 
               window.navigator.standalone === true;
    }
    
    // Verificar se o modal já foi mostrado (usando localStorage)
    function hasSeenAddToHomePrompt() {
        return localStorage.getItem('addToHomePromptShown') === 'true';
    }
    
    // Marcar como já mostrado
    function markAddToHomePromptShown() {
        localStorage.setItem('addToHomePromptShown', 'true');
    }
    
    // Mostrar o modal
    function showAddToHomeModal() {
        addToHomeModal.style.display = 'block';
        // Pequeno delay para a animação funcionar
        setTimeout(() => {
            addToHomeModal.classList.add('show');
        }, 50);
    }
    
    // Esconder o modal
    function hideAddToHomeModal() {
        addToHomeModal.classList.remove('show');
        setTimeout(() => {
            addToHomeModal.style.display = 'none';
        }, 300);
        markAddToHomePromptShown();
    }
    
    // Event listener para fechar o modal
    closeAddToHomeModal.addEventListener('click', hideAddToHomeModal);
    
    // Fechar modal clicando fora do conteúdo
    addToHomeModal.addEventListener('click', (e) => {
        if (e.target === addToHomeModal) {
            hideAddToHomeModal();
        }
    });
    
    // Mostrar o modal após 3 segundos se atender as condições
    setTimeout(() => {
        if (isMobileDevice() && !isStandalone() && !hasSeenAddToHomePrompt()) {
            showAddToHomeModal();
        }
    }, 3000);
    
    // Esconder modal ao pressionar ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && addToHomeModal.classList.contains('show')) {
            hideAddToHomeModal();
        }
    });
});
