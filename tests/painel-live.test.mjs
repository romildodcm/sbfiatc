import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const lib = join(root, 'painel', 'painel-live.js');

const { default: PainelLive } = await import(`file://${lib}`);

function fixture(name) {
  return JSON.parse(readFileSync(join(here, 'fixtures', 'sbfi-live', name), 'utf8'));
}

/* fetch falso: devolve a próxima resposta da fila (para testar 429, rede etc.) */
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (h) => (next.headers || {})[String(h).toLowerCase()] || next.headers?.[h] || null },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body))
    };
  };
  fn.calls = calls;
  return fn;
}

function client(fetchImpl, opts) {
  let clock = 1_000_000;
  const c = PainelLive.createClient({
    fetch: fetchImpl,
    now: () => clock,
    setTimeout: () => 1,
    clearTimeout: () => {},
    ...opts
  });
  return { c, advance: (ms) => { clock += ms; }, state: () => c.getState() };
}

/* ------------------------------------------------------------------ */

test('200 com voo: normaliza a rodada inteira', async () => {
  const doc = fixture('flight.json');
  const { c } = client(fakeFetch([{ status: 200, body: doc }]));

  await c.load();

  const st = c.getState();
  assert.equal(st.phase, 'ok');
  assert.equal(st.status, 200);
  assert.equal(st.error, '');
  assert.equal(st.live.windowMinutes, 10);
  assert.equal(st.live.stale, false);
  assert.equal(st.live.airport.icao, 'SBFI');
  assert.equal(st.live.airport.iata, 'IGU');
  assert.equal(st.live.rotation.pageSeconds, 30);
  assert.equal(st.live.screens.length, doc.screens.length);
  assert.ok(st.live.generatedAt > 0, 'generatedAt ISO vira epoch ms');

  const s = st.live.screens[0];
  assert.equal(s.type, 'flight');
  assert.equal(s.flight, 'TAM3460');
  assert.equal(s.airlineName, 'LATAM');
  assert.equal(s.levelText, 'FL172');
  assert.equal(s.distText, '90 KM FROM SBFI');
  assert.equal(s.depText, 'DEP --:--');
  assert.equal(s.model, 'TYPE ?');
  assert.equal(s.verticalTrend, 'descending');
  assert.equal(s.originText, '');
  assert.equal(s.airline.logoKey, 'TAM');
});

test('request sem credencial, sem query string e sem cache', async () => {
  const f = fakeFetch([{ status: 200, body: fixture('flight.json') }]);
  const { c } = client(f);
  await c.load();

  const call = f.calls[0];
  assert.equal(call.url, `${PainelLive.DEFAULT_API}/api/sbfi/live`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.cache, 'no-store');
  assert.ok(!/authorization/i.test(Object.keys(call.init.headers || {}).join(',')));
});

test('ordem e textos das telas vêm do servidor (nada é recalculado)', async () => {
  const doc = fixture('multi.json');
  const { c } = client(fakeFetch([{ status: 200, body: doc }]));
  await c.load();

  const screens = c.getState().live.screens;
  assert.deepEqual(screens.map((s) => s.flight), doc.screens.map((s) => s.flight));
  assert.deepEqual(screens.map((s) => s.positionText), ['1/3', '2/3', '3/3']);
  assert.deepEqual(screens.map((s) => s.distText), doc.screens.map((s) => s.distText));
  assert.deepEqual(screens.map((s) => s.levelText), doc.screens.map((s) => s.levelText));
  assert.deepEqual(screens.map((s) => s.etaText), doc.screens.map((s) => s.etaText));
  assert.deepEqual(screens.map((s) => s.depText), doc.screens.map((s) => s.depText));
  assert.deepEqual(screens.map((s) => s.originText), doc.screens.map((s) => s.originText));
  assert.deepEqual(screens.map((s) => s.destinationText), doc.screens.map((s) => s.destinationText));
});

test('telas empty/error trazem as 3 linhas prontas e o relógio', async () => {
  for (const [file, type] of [['error.json', 'error'], ['empty.json', 'empty']]) {
    const doc = fixture(file);
    const { c } = client(fakeFetch([{ status: 200, body: doc }]));
    await c.load();
    const s = c.getState().live.screens[0];
    assert.equal(s.type, type);
    assert.equal(s.lines.length, 3);
    assert.equal(s.lines[0], 'IGU / IGR / AGT');
    assert.match(s.clock, /^\d{2}:\d{2}:\d{2}$/);
  }
});

test('stale=true mantém a rodada e a idade da fonte', async () => {
  const { c } = client(fakeFetch([{ status: 200, body: fixture('stale.json') }]));
  await c.load();

  const st = c.getState();
  assert.equal(st.live.stale, true);
  assert.equal(st.live.staleAgeSeconds, 75);
  assert.equal(st.live.screens.length, 3);
  assert.equal(st.phase, 'ok');
});

test('429 não apaga a rodada anterior e respeita o Retry-After', async () => {
  const { c, advance, state } = client(fakeFetch([
    { status: 200, body: fixture('flight.json') },
    { status: 429, headers: { 'retry-after': '3' }, body: fixture('429.json') }
  ]));

  await c.load();
  const before = state().live;
  assert.equal(before.screens.length, 1);

  advance(10_000);
  await c.load();

  const st = state();
  assert.equal(st.errorKind, 'rate');
  assert.equal(st.status, 429);
  assert.equal(st.retryAfterMs, 3000);
  assert.equal(st.live, before, 'a última rodada boa continua sendo a exibida');
  assert.equal(st.phase, 'ok', 'com dado em tela o painel segue renderizando');
});

test('erro de rede preserva a rodada; sem rodada fica em phase=error', async () => {
  const booom = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
  const { c, advance, state } = client(fakeFetch([booom]));

  await c.load();
  assert.equal(state().phase, 'error');
  assert.equal(state().errorKind, 'net');
  assert.equal(state().live, null);

  /* agora chegou dado e depois a rede caiu de novo */
  const { c: c2, advance: adv2, state: st2 } = client(fakeFetch([
    { status: 200, body: fixture('flight.json') },
    booom
  ]));
  await c2.load();
  adv2(10_000);
  await c2.load();
  assert.equal(st2().live.screens.length, 1);
  assert.equal(st2().phase, 'ok');
  assert.equal(st2().errorKind, 'net');
});

test('5xx classifica como fonte fora do ar', async () => {
  const { c, state } = client(fakeFetch([{ status: 503, body: 'oops' }]));
  await c.load();
  assert.equal(state().errorKind, 'server');
  assert.equal(state().status, 503);
});

test('resposta inválida não derruba: erro de parse, sem rodada', async () => {
  const { c, state } = client(fakeFetch([{ status: 200, body: '{"screens": 3}' }]));
  await c.load();
  assert.equal(state().phase, 'error');
  assert.equal(state().errorKind, 'parse');
});

test('respeita o intervalo de 10 s entre buscas', async () => {
  const f = fakeFetch([{ status: 200, body: fixture('flight.json') }]);
  const { c, advance, state } = client(f);

  await c.load();
  assert.equal(f.calls.length, 1);

  await c.load();                     // ainda dentro da janela: não busca
  assert.equal(f.calls.length, 1);

  advance(9_000);
  await c.load();
  assert.equal(f.calls.length, 1);

  advance(1_000);
  await c.load();
  assert.equal(f.calls.length, 2);
  assert.ok(state().nextFetchAt > state().lastFetchAt);
});

test('request simultânea reaproveita o mesmo fetch', async () => {
  const f = fakeFetch([{ status: 200, body: fixture('flight.json') }]);
  const { c } = client(f);
  await Promise.all([c.load(), c.load(), c.load()]);
  assert.equal(f.calls.length, 1);
});

/* ---------------------------- logos ------------------------------- */

test('logo RGB565 40 × 27 decodifica para RGBA 40 × 27', async () => {
  const doc = fixture('flight.json');
  const dto = doc.logos.TAM;
  const logo = PainelLive.decodeLogo(dto);

  assert.equal(dto.format, 'rgb565');
  assert.equal(logo.width, 40);
  assert.equal(logo.height, 27);
  assert.equal(logo.rgba.length, 40 * 27 * 4);
  for (let i = 3; i < logo.rgba.length; i += 4) assert.equal(logo.rgba[i], 255, 'alpha opaco');
});

test('RGB565: 0xFFFF vira branco cheio e 0x0000 preto', () => {
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  const white = PainelLive.decodeLogo({ bitmap: b64([0xff, 0xff]), width: 1, height: 1, format: 'rgb565' });
  const black = PainelLive.decodeLogo({ bitmap: b64([0, 0]), width: 1, height: 1, format: 'rgb565' });
  assert.deepEqual([...white.rgba], [255, 255, 255, 255]);
  assert.deepEqual([...black.rgba], [0, 0, 0, 255]);
});

test('cliente entrega o logo pelo logoKey, com cache por hash', async () => {
  const { c } = client(fakeFetch([{ status: 200, body: fixture('flight.json') }]));
  await c.load();
  const a = c.logoFor('TAM');
  const b = c.logoFor('TAM');
  assert.ok(a && a.width === 40);
  assert.equal(a, b, 'segunda consulta vem do cache');
  assert.equal(c.logoFor('GLO'), null, 'logoKey ausente em logos -> null (sigla)');
});

/* -------------------- caso real de produção ----------------------- */

test('todas as fixtures reais do endpoint passam no normalizador', () => {
  const dir = join(here, 'fixtures', 'sbfi-live');
  const files = readdirSync(dir).filter((f) => f !== '429.json');
  assert.ok(files.length >= 5);
  for (const f of files) {
    const live = PainelLive.normalize(fixture(f));
    assert.ok(live.screens.length >= 1, `${f}: pelo menos uma tela`);
    assert.equal(typeof live.stale, 'boolean');
    assert.ok(live.rotation.pageSeconds > 0);
    for (const s of live.screens) {
      assert.ok(['flight', 'empty', 'error'].includes(s.type), `${f}: tipo ${s.type}`);
    }
  }
});

test('generatedAt aceita ISO, epoch em segundos e em milissegundos', () => {
  assert.equal(PainelLive.timeOf('2026-11-23T12:52:58Z'), Date.parse('2026-11-23T12:52:58Z'));
  assert.equal(PainelLive.timeOf(1763902378), 1763902378000);
  assert.equal(PainelLive.timeOf(1763902378000), 1763902378000);
  assert.equal(PainelLive.timeOf(null), 0);
});
