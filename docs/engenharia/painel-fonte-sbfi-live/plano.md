# Plano de Engenharia — Painel de LED consumindo `GET /api/sbfi/live`

## Contexto e Objetivo

O painel (`/painel`, `painel/painel.js` — 2.175 linhas) hoje **reimplementa toda a regra de
negócio no navegador**: autentica na API (login JWT), busca `/api/aircraft/live?minutes=10`,
enriquece com o ADSBDB (rota/companhia/modelo, caches de 24 h e 7 h em `localStorage`),
decide status (chegada/partida/sobrevoo), calcula ETA, monta a rodada de telas, trunca os
textos e baixa/quantiza o logo da companhia.

O backend do AirGateway.Api já entrega tudo isso pronto em `GET /api/sbfi/live`
(`SbfiLiveResponse`) — público, sem query string, com `Cache-Control: public, max-age=10`,
textos já truncados no layout de 128 × 64 e logo quantizada (`logos[key].bitmap`).
Verificado em 23/11/2026 12:52 UTC: `200`, 383 bytes, CORS liberado para
`https://atc.iguspotters.com.br`, tela `error` / `no-signal` com `lines` prontas.

**Objetivo:** trocar a fonte de dados do painel por esse endpoint, **mantendo o layout da
tela exatamente o mesmo**, e eliminar do navegador a regra de negócio que agora é do servidor.

## Estado atual e o que sai (com prova de código)

| Bloco em `painel/painel.js` | Linhas | Destino |
|---|---|---|
| Login JWT, `login()`, `userLabel()`, `resolveAirportId()`, `fetchLive()` | 421–583 | **Sai** (endpoint é público) |
| ADSBDB: `fetchRoute`, `fetchAircraft`, `airportOf`, `enrich`, caches `LS_ROUTES`/`LS_AC` | 585–724, 1467–1493 | **Sai** |
| `normalizeLive()` (OpenSky → aeronave), `trendOf()` | 726–783 | **Sai** |
| `cardData()` (origem/destino, ETA, DEP, km), `rowsOf()`, `orderedFlights()`, `buildScreens()` | 858–957 | **Sai** (ordem e corte são do servidor) |
| Logo: `logoUrls`, `quantizeLogo` (canvas 40×27), `ensureLogo` | 959–1106 | **Sai** (vira `logos[key].bitmap`) |
| `airlineName()` (tabela `AIRLINES`), `levelOf()`, `kmText()`, `distLine()` | 1112–1236 | **Sai** (vêm `airlineName`, `levelText`, `distText`) |
| Configurações (e-mail/senha, `btnClearKey`, `updateCfgStatus` com token) | 1495–1567 | **Sai** do formulário; painel volta a ser público |
| Demo com dados falsos (`DEMO`, `demoFlight`, `applyDemo`) | 1779–2149 | **Reescreve** para payloads `SbfiLiveResponse` |
| Desenho: `drawFlight`, `drawEmpty`, `drawError`, `ROUTE_ARROW`, `textRoute`, `drawTrend`, `FONT`, `px`, `fit` | 98–349, 1108–1429, 1756–1777 | **Fica** — nenhuma coordenada muda |

## Escopo

**Incluído**
- Novo módulo `painel/painel-live.js` (`window.PainelLive`): cliente puro do endpoint —
  `fetch` sem credenciais, timeout via `AbortController`, tratamento de `429` + `Retry-After`,
  cache de janela de 10 s, `stale`/`staleAgeSeconds`, `logos` → `ImageData` usado por
  `putImageData` (sem `drawImage`/`canvas` de quantização), rotação de tela por
  `rotation.pageSeconds` / `screens[].index`, mantendo o voo na tela pelo `icao`, e a
  última rodada boa em memória.
- Reescrita do trecho de rede/estado de `painel.js`: `state.live`, `refresh()`,
  `tick()`, `draw()`, `drawFlight()`, `drawEmpty()`, `drawError()`, `nextScreen()`,
  `screenText()`.
- `painel/index.html`: adicionar `<script src="/painel/painel-live.js" defer>` antes de
  `painel.js`; remover os campos de e-mail/senha do bloco de Configurações (o layout do
  **painel** não muda; o overlay de Configurações perde os campos e mantém "Como usar",
  status e crédito).
- `sw.js`: incluir `/painel/painel-live.js` em `STATIC_RESOURCES` e subir `CACHE_NAME` para
  `sbfi-atc-v22`.
- Modo demo (`?demo=`) migrado para payloads reais do endpoint, com novos cenários
  `stale` e `empty`.
- Teste de contrato estático em `tests/painel-live.test.mjs` (Node 22 + `node:test`, sem
  dependência nova): parseia `painel-live.js` + fixtures em `tests/fixtures/sbfi-live/`
  (resposta real capturada, `error`, `empty`, multi-tela, `stale`, `429`).
- Atualizar o comentário de cabeçalho de `painel.js` (linhas 1–24) e o
  `docs/prompt-layout-painel.md` (fonte dos dados).

**Fora de escopo**
- Qualquer mudança no AirGateway.Api (o endpoint já está no ar).
- Mudança em coordenadas, fontes, cores, `LOGO_W`/`LOGO_GAP`/`LOGO_TEXT_X`, `PAGE_MS`
  (30 s), fonia (`radio-recorder.js`), tela cheia, `keep-awake.js`.
- O painel físico ESP32.

## Arquitetura e Abordagem Técnica

```
                    ┌────────────────────────── painel-live.js ──────────────────────────┐
GET /api/sbfi/live →│ fetch (cache:'no-store', AbortController 8 s, credentials omit)      │
   (10 s cache)     │  ├─ 200 → valida {screens[], logos, rotation, stale, generatedAt}   │
                    │  ├─ 429 → Retry-After (s) → próxima tentativa; devolve 429          │
                    │  └─ erro de rede → devolve erro; última rodada boa é preservada     │
                    │  logos: bitmap base64 → ImageData(40×27) (cache por hash)           │
                    └────────────────────────────────────────────────────────────────────┘
                                        │  getState()
                                        ▼
painel.js  state.live = PainelLive.getState()
           drawFlight(screen, logos, posição na rodada)  ← já existente, só troca a origem do dado
           drawEmpty(screen.lines) / drawError(screen.lines)  ← 3 linhas prontas do servidor
```

### Decisões de desenho

1. **Layout não muda por contrato de campos, não por ajuste visual.** O desenho continua
   nas mesmas coordenadas; troca-se só o objeto lido:

   | Elemento na tela | Antes (derivado no cliente) | Agora (campo do endpoint) |
   |---|---|---|
   | linha 1 (y 0), x=44 | `airlineName(d)` | `screen.airlineName` |
   | linha 2 (y 9) | `truncate(d.flight, …)` | `screen.flight` |
   | seta de tendência | `drawTrend(d.trend)` | `screen.verticalTrend` |
   | linha 3 (y 23) | `codeOf(origin)` + seta + `codeOf(destination)` | `"originText ⟶ destinationText"` montado do par de campos |
   | FL na borda direita | `levelOf(d)` | `screen.levelText` |
   | linha 4 (y 34) | `truncate(d.model \|\| 'TYPE ?', 21)` | `screen.model` |
   | linha 5 (y 45) | `clockOf(depMs)` / `clockOf(etaMs)` | `screen.depText` / `screen.etaText` |
   | linha 6 (y 56) | `distLine(d)` | `screen.distText` |
   | canto direito (y 56) | `(i+1)/n` calculado no cliente | `screen.positionText` |
   | logo 40×27 | `ensureLogo` + `quantizeLogo` + fallback sigla | `logos[key].bitmap`; sem bitmap → sigla em caixa de 40×27 (fallback atual preservado) |

   Regra de segurança para não estourar o desenho: o cliente aplica **apenas os cortes já
   existentes** (`truncate`/`truncateToWidth`/`textRoute` com `folga`, `vooMax`, `rotaMax`,
   `distMax`) sobre o texto do servidor — corte é idempotente e protege contra resposta
   fora do contrato, sem alterar um pixel do caso conforme.

2. **Zero re-login, zero chamada a terceiros.** Ficam no browser só o endpoint e o stream de
   fonia. O `localStorage` deixa de guardar credenciais e caches (`sbfiPainelApi`,
   `sbfiRadarRoutes`, `sbfiRadarAc`) — remover essas chaves no primeiro load (higiene/LGPD),
   mantendo `sbfiPainelReload`.

3. **Cadência** = `windowMinutes`/`pageSeconds` do payload. Intervalo de fetch de **10 s**
   (igual ao `max-age` do servidor); a troca de tela continua em `PAGE_MS` = 30 s. Numa TV
   que fica ligada, isso ainda são ~8.640 chamadas/dia (leve, mas contável) — por isso se
   mantém a pausa em `document.hidden` e o refresh imediato no `visibilitychange`.

4. **`stale` e falha de rede não apagam a tela.** Com `stale: true`, segue exibindo a última
   rodada boa; o status de Configurações mostra `STALE 42s`. Falha de rede/`429` mantém a
   última rodada; sem nunca ter tido resposta, `drawError()` desenha `STANDBY` (fase de
   boot) e depois `NO SIGNAL` / `API / NET`, com `TOO MANY TRIES` / `AGUARDE` no `429` —
   textos client-side só para os três casos de tela sem dados, como hoje.

5. **Telas `empty`/`error` vêm prontas.** O servidor manda `lines` (3 linhas) e `clock`;
   `drawEmpty`/`drawError` desenham exatamente `lines[0]` em y 12, `lines[1]` em y 26,
   `lines[2]` em y 38 e `clock + ' UTC'` em y 52 — mesmas posições/cores atuais (cyan,
   amber/dim, white). Um caso inválido (`lines` com menos de 3 itens) cai no desenho atual.

6. **Logo por bitmap.** `logos[key]` é indexado em `screen.airline.logoKey`; o servidor já
   entrega 40 × 27 quantizado (mesmo recorte/quantização do `quantizeLogo` atual segundo
   `docs/prompt-backend-airgateway-sbfi-live.md`). O cliente só decodifica o base64 para
   `ImageData` e faz `ledCtx.putImageData`, ou `px()` no buffer do frame (padrão já usado).
   Cache por `hash`; ausência do `logoKey` em `logos` mantém a sigla.

7. **Dependência nova:** nenhuma. O módulo é ES5/UMD (`window.PainelLive`) para carregar por
   `<script>` como o resto da página, e testável no Node via import dinâmico do globo.

## Decomposição em Tarefas

1. **[Story] Cliente `painel-live.js` + teste de contrato**
   - Descrição: criar `painel/painel-live.js` com `load()`, `getState()`, timeout, `429` +
     `Retry-After`, cache de 10 s, decodificação de `logos` e preservação da última rodada
     boa. Criar `tests/painel-live.test.mjs` + fixtures (resposta real, `error`, `empty`,
     multi, `stale`, `429`).
   - Critérios de aceite: [ ] `node --test tests/` verde; [ ] `200` vira estado com
     `screens`, `logos`, `rotation`, `stale`; [ ] `429` não apaga a rodada anterior;
     [ ] erro de rede preserva a última rodada; [ ] Nenhuma referência a login/ADSBDB no
     módulo.
   - Depende de: —

2. **[Task] Troca da fonte em `painel.js` (rede + estado + ciclo)**
   - Descrição: remover login/ADSBDB/`normalizeLive`/`cardData`/`enrich`/caches; `refresh()`
     passa a chamar `PainelLive.load()`; `state.live` substitui `state.aircraft`/`screens`;
     `tick()` usa `state.live.pageSeconds`; remover chaves antigas do `localStorage`.
   - Critérios de aceite: [ ] `grep` não encontra `login(`, `adsbdb`, `aircraft/live`;
     [ ] refresh a cada 10 s, página a cada 30 s; [ ] sem chamadas com `Authorization`;
     [ ] `?debug=1` loga `GET /api/sbfi/live`, `screens: n`, `stale`.
   - Depende de: 1

3. **[Task] Desenho por campos do endpoint, sem mover um pixel**
   - Descrição: `drawFlight(screen, logoPx, pos)` lê `airlineName`, `flight`,
     `verticalTrend`, `originText`/`destinationText`, `levelText`, `model`, `depText`,
     `etaText`, `distText`, `positionText`; `drawEmpty`/`drawError` desenham `lines`/`clock`;
     remover `airlineName()`, `levelOf()`, `kmText()`, `distLine()`, `clockOf()`,
     `centerCode()`, `AREA_LABEL`, tabela `AIRLINES`, `ROUTE_ARROW` (mantém se usada para o
     separador de rota) e `textRoute` ajustado.
   - Critérios de aceite: [ ] Comparação screenshot por tela (`?demo=`) antes/depois
     idêntica nos cenários `arrival`, `departure`, `overflight`, `unknown`, `multi`,
     `trend`, `empty`, `err-net`; [ ] Clique no painel copia o mesmo texto de antes
     (`screenText()`); [ ] Setas ← → continuam trocando de tela.
   - Depende de: 2

4. **[Task] Logo por `logos[key].bitmap` com fallback de sigla**
   - Descrição: `logoImage(id)` decodifica o bitmap para o buffer do frame (40 × 27 em
     `logoY = 1`); sem bitmap ou sem `logoKey`, desenha a caixa + sigla como hoje;
     remover `logoUrls`, `quantizeLogo`, `ensureLogo`, `LOGO_LOCAL`, `LOGO_API`.
   - Critérios de aceite: [ ] Logo idêntico ao atual para GOL/LATAM/JetSmart quando o
     payload trouxer `bitmap`; [ ] Sem `Image()`/`crossOrigin`/2D canvas auxiliar no painel
     normal; [ ] Nenhum request para `/airlines/` ou `pics.avs.io`.
   - Depende de: 3

5. **[Task] Error/empty/429/stale no painel**
   - Descrição: `drawError()` distingue boot (`STANDBY`), `429` (`TOO MANY TRIES` +
     `AGUARDE`), rede (`NO SIGNAL` + `API / NET`) e tela `error` do servidor (`lines`);
     `stale` não troca a rodada e atualiza `updateCfgStatus()` com `STALE <n>s`.
   - Critérios de aceite: [ ] `?demo=stale` mantém o voo na tela com aviso no status;
     [ ] `?demo=err-rate` mostra `TOO MANY TRIES`; [ ] `?demo=empty` mostra
     `IGU / IGR / AGT` / `NO FLIGHTS` / `NO TRAFFIC` + relógio UTC.
   - Depende de: 3

6. **[Task] Configurações sem credenciais + HTML/SW/versão**
   - Descrição: overlay perde e-mail/senha e o botão "limpar"; `cfgStatus` mostra API,
     estação, telas, última leitura, `stale`, `windowMinutes`; `index.html` carrega
     `painel-live.js`; `sw.js` caches o novo arquivo e sobe `CACHE_NAME`; atualizar
     comentário de cabeçalho do `painel.js`.
   - Critérios de aceite: [ ] Abrir `/painel` num navegador limpo renderiza sem interação;
     [ ] `sw.js` v22 com `/painel/painel-live.js`; [ ] Nenhum campo de senha no DOM.
   - Depende de: 5

7. **[Task] Modo demo com payloads reais + docs**
   - Descrição: substituir `DEMO` por fixtures no formato `SbfiLiveResponse` (cenários
     acima + `stale`), mantendo a barra de cenários; atualizar
     `docs/prompt-layout-painel.md` (fonte = `GET /api/sbfi/live`) e criar
     `docs/engenharia/painel-fonte-sbfi-live/README.md` com o mapeamento campo → linha.
   - Critérios de aceite: [ ] Todos os cenários do demo carregam somente de fixture, sem
     rede; [ ] Documentação aponta o endpoint e o contrato.
   - Depende de: 5

## Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| **Cliente de TV (Fire Stick/iPad) com cache velho** — SW v21 serve `painel.js` antigo chamando `/api/aircraft/live` | `CACHE_NAME` → v22 (instala e limpa o anterior), `isCodeUrl` já é network-first; o reload de segurança do topo do `painel.js` permanece |
| **Formato de `generatedAt`** — documentado como `number`, mas a produção devolve ISO `"2026-11-23T12:52:58Z"` | Cliente aceita os dois (`Date.parse` e epoch em s/ms) |
| **`bitmap` com tamanho/proporção diferente de 40 × 27** — endpoint devolveu `logos: {}` nas capturas | Decodificador aceita `width`/`height` do DTO e escala para o bloco com `px()`; validar com payload real de voo antes do merge |
| **`positionText`/`distText` nulos ou vazios** | Desenhar só quando não vazios, como hoje (`pos && posW`) |
| **Truncamento diferente do servidor** (ex.: nome 15 chars onde hoje cai para 14) | Os cortes existentes continuam aplicados; comparar screenshots |
| **`stale` prolongado esconde operação real** | Exibir `STALE <n>s` no status e relógio UTC na tela de erro não muda (regra do servidor) |
| **Rate limit**: 1 requisição/10 s por display | Intervalo = `max-age` do servidor; `Retry-After` respeitado no `429` |

## Definition of Done

- [ ] `/painel` renderiza sem login; **layout visualmente idêntico** ao atual (comparação por
      screenshot em todos os cenários do demo).
- [ ] Nenhum request do painel para `adsbdb`, `/airlines/`, `pics.avs.io` ou
      `/api/aircraft/live`; única chamada de dados é `GET /api/sbfi/live`.
- [ ] Fonia, tela cheia, copiar e demo funcionando.
- [ ] `node --test tests/` verde.
- [ ] `sw.js` v22 e `painel-live.js` no cache estático.
- [ ] Docs atualizadas (`docs/prompt-layout-painel.md`, `docs/engenharia/.../README.md`).
- [ ] PR aberto com checklist de aceite por tarefa.
