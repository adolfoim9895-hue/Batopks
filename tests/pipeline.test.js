import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/lib/run.js';
import { validateOutput } from '../scripts/lib/validateOutput.js';
import { rng, makeTeams, simulateSeason, toFdMatch, NOW, jsonRes } from './helpers.js';

const baseCfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const cfg = structuredClone(baseCfg);
cfg.footballData.competitions = ['PL'];
cfg.footballData.minIntervalMs = 0;
cfg.apiFootball.leagues = [];

function buildFd() {
  const r = rng(99);
  const teams = makeTeams(18, r, 0.3);
  const cur = simulateSeason(teams, Date.parse('2026-08-01'), 300, NOW, r);
  const p1 = simulateSeason(teams, Date.parse('2025-08-01'), 300, NOW, r);
  const p2 = simulateSeason(teams, Date.parse('2024-08-01'), 300, NOW, r);
  // partido de la semana con un equipo recién llegado, sin historial
  const newbie = { id: 9999, name: 'Recién Llegado', att: 1, def: 1 };
  cur.push({ h: teams[0], a: newbie, date: Date.parse('2026-11-23T15:00:00Z'), done: false, gh: null, ga: null });
  const mk = (sim, y) => sim.map((m, i) => toFdMatch(m, y * 10000 + i, y));
  return {
    '/competitions/PL/matches': { competition: { name: 'Premier League', area: { name: 'England' }, emblem: null }, matches: mk(cur, 2026) },
    'season=2025': { competition: { name: 'Premier League' }, matches: mk(p1, 2025) },
    'season=2024': { competition: { name: 'Premier League' }, matches: mk(p2, 2024) },
  };
}

function makeFetch(fd, calls = []) {
  return async (url, opts) => {
    calls.push(url);
    if (url.includes('api.football-data.org')) {
      if (url.includes('season=2025')) return jsonRes(fd['season=2025']);
      if (url.includes('season=2024')) return jsonRes(fd['season=2024']);
      return jsonRes(fd['/competitions/PL/matches']);
    }
    if (url.includes('api.openai.com')) return openAi(opts);
    return jsonRes({}, 404);
  };
}

let openAiCalls = 0;
function openAi() {
  openAiCalls++;
  const payload = {
    injuries: [
      { team: 'home', player: 'Jugador Uno', status: 'out', detail: 'lesión muscular', source_url: 'https://ejemplo.com/parte-medico?utm=1', source_date: '2026-11-21' },
      { team: 'home', player: 'Jugador Dos', status: 'out', detail: null, source_url: 'https://ejemplo.com/parte-medico', source_date: null },
      { team: 'home', player: 'Inventado', status: 'out', detail: null, source_url: 'https://no-citado.com/x', source_date: null },
    ],
    suspensions: [],
    rotation: { level: 'unknown', team: 'none', reason: null, source_url: null },
    lineup: { confirmed: false, home: [], away: [], source_url: null },
    summary: 'prueba',
  };
  return jsonRes({
    output: [
      { type: 'web_search_call' },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload), annotations: [{ type: 'url_citation', url: 'https://ejemplo.com/parte-medico', title: 'Parte médico' }] }] },
    ],
    usage: { input_tokens: 6000, output_tokens: 800 },
  });
}

test('Pipeline completo sin IA: salida válida, ventana semanal y DATOS INSUFICIENTES para equipo sin historial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-'));
  const out = await run({ cfg, env: { FOOTBALL_DATA_KEY: 'k' }, fetchImpl: makeFetch(buildFd()), now: NOW, outDir: join(dir, 'out'), cacheDir: join(dir, 'c'), log: () => {} });
  assert.deepEqual(validateOutput(out), []);
  assert.ok(existsSync(join(dir, 'out', 'predictions.json')));
  assert.ok(out.matches.length >= 5, `partidos: ${out.matches.length}`);
  const start = Date.parse('2026-11-22T00:00:00Z');
  for (const m of out.matches) {
    const t = Date.parse(m.kickoff);
    assert.ok(t >= start && t < start + 8 * 864e5, 'fuera de ventana');
  }
  const newbie = out.matches.find((m) => m.away.name === 'Recién Llegado');
  assert.equal(newbie.dataStatus, 'DATOS INSUFICIENTES');
  assert.equal(newbie.probs, null);
  assert.equal(newbie.confidence.tier, null);
  const ok = out.matches.filter((m) => m.dataStatus === 'OK');
  assert.ok(ok.length > 0);
  for (const m of ok) {
    assert.ok(m.explain.length >= 5);
    if (m.confidence.tier) assert.ok(m.confidence.bucket.n >= 30, 'nivel sin validación');
  }
  assert.equal(out.sources.find((s) => s.name === 'OpenAI (web search)').status, 'sin_clave');
  assert.equal(out.validation.skillOK, true);
});

test('Caché: una segunda ejecución no vuelve a llamar a football-data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-'));
  const calls = [];
  const f = makeFetch(buildFd(), calls);
  const args = { cfg, env: { FOOTBALL_DATA_KEY: 'k' }, fetchImpl: f, now: NOW, cacheDir: join(dir, 'c'), log: () => {} };
  await run(args);
  const first = calls.filter((u) => u.includes('football-data')).length;
  assert.equal(first, 3);
  await run(args);
  assert.equal(calls.filter((u) => u.includes('football-data')).length, first);
});

test('Sin claves y con proveedores caídos: la app no se rompe (salida válida y vacía)', async () => {
  const out = await run({ cfg, env: {}, fetchImpl: async () => { throw new Error('sin red'); }, now: NOW, log: () => {} });
  assert.deepEqual(validateOutput(out), []);
  assert.equal(out.matches.length, 0);
  assert.equal(out.sources.find((s) => s.name === 'football-data.org').status, 'sin_clave');
});

test('Si football-data falla, se usa caché vencida (degradación elegante)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-'));
  const fd = buildFd();
  await run({ cfg, env: { FOOTBALL_DATA_KEY: 'k' }, fetchImpl: makeFetch(fd), now: NOW, cacheDir: join(dir, 'c'), log: () => {} });
  const later = NOW + 40 * 3600e3; // caché de 3 h ya vencida
  const out = await run({ cfg, env: { FOOTBALL_DATA_KEY: 'k' }, fetchImpl: async () => jsonRes({}, 500), now: later, cacheDir: join(dir, 'c'), sleep: async () => {}, log: () => {} });
  assert.deepEqual(validateOutput(out), []);
  assert.ok(out.sources[0].status === 'ok' || out.sources[0].status === 'parcial');
});

test('IA: descarta afirmaciones sin cita real, calcula costo y no altera las probabilidades', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-'));
  const fd = buildFd();
  const without = await run({ cfg, env: { FOOTBALL_DATA_KEY: 'k' }, fetchImpl: makeFetch(fd), now: NOW, cacheDir: join(dir, 'c1'), log: () => {} });
  openAiCalls = 0;
  const withAi = await run({ cfg, env: { FOOTBALL_DATA_KEY: 'k', OPENAI_API_KEY: 'sk-test' }, fetchImpl: makeFetch(fd), now: NOW, cacheDir: join(dir, 'c2'), log: () => {} });
  assert.deepEqual(validateOutput(withAi), []);
  assert.ok(openAiCalls > 0 && openAiCalls <= cfg.ai.maxMatches);
  const analysed = withAi.matches.filter((m) => m.ai && m.ai.status === 'OK');
  assert.ok(analysed.length > 0);
  for (const m of analysed) {
    const players = m.ai.injuries.map((i) => i.player);
    assert.deepEqual(players, ['Jugador Uno', 'Jugador Dos']);
    assert.equal(m.ai.droppedClaims, 1);
    assert.ok(m.warnings.some((w) => w.text.includes('🔴 ADVERTENCIA') && w.ai));
    assert.notEqual(m.confidence.tier, 'alta');
    const base = without.matches.find((x) => x.id === m.id);
    assert.deepEqual(m.probs, base.probs, 'la IA no debe cambiar las probabilidades');
  }
  const info = withAi.sources.find((s) => s.name === 'OpenAI (web search)');
  assert.ok(info.costUsd > 0 && info.costUsd < 0.1 * openAiCalls);
});

test('IA caída: la app sigue y marca DATOS INSUFICIENTES de IA', async () => {
  const fd = buildFd();
  const f = async (url, o) => (url.includes('openai') ? jsonRes({}, 500) : makeFetch(fd)(url, o));
  const out = await run({ cfg, env: { FOOTBALL_DATA_KEY: 'k', OPENAI_API_KEY: 'sk' }, fetchImpl: f, now: NOW, log: () => {} });
  assert.deepEqual(validateOutput(out), []);
  assert.ok(out.matches.some((m) => m.dataStatus === 'OK'));
});
