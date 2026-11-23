import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/lib/run.js';
import { buildResearchRequest, applyResearch, loadResearch } from '../scripts/lib/research.js';
import { validateOutput } from '../scripts/lib/validateOutput.js';
import { rng, makeTeams, simulateSeason, toFdMatch, NOW, jsonRes } from './helpers.js';

const baseCfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const cfg = structuredClone(baseCfg);
cfg.footballData.competitions = ['PL'];
cfg.footballData.minIntervalMs = 0;
cfg.apiFootball.leagues = [];

function fdFetch() {
  const r = rng(99);
  const teams = makeTeams(18, r, 0.3);
  const mk = (sim, y) => sim.map((m, i) => toFdMatch(m, y * 10000 + i, y));
  const cur = mk(simulateSeason(teams, Date.parse('2026-08-01'), 300, NOW, r), 2026);
  const p1 = mk(simulateSeason(teams, Date.parse('2025-08-01'), 300, NOW, r), 2025);
  const p2 = mk(simulateSeason(teams, Date.parse('2024-08-01'), 300, NOW, r), 2024);
  const meta = { competition: { name: 'Premier League', area: { name: 'England' } } };
  return async (url) => {
    if (!url.includes('football-data')) return jsonRes({}, 404);
    return jsonRes({ ...meta, matches: url.includes('season=2025') ? p1 : url.includes('season=2024') ? p2 : cur });
  };
}

const mkMatch = (id, over = {}) => ({
  id,
  kickoff: new Date(NOW + 5 * 3600e3).toISOString(),
  status: 'SCHEDULED',
  dataStatus: 'OK',
  competition: { key: 'PL', name: 'Premier League', country: 'England', order: 0 },
  home: { name: 'Local' },
  away: { name: 'Visita' },
  probs: { home: 0.65, draw: 0.2, away: 0.15 },
  confidence: { tier: 'alta', reason: '', bucket: { lo: 0.6, hi: 0.7, n: 60, actual: 0.66, avgPred: 0.65 } },
  warnings: [],
  explain: [],
  ai: null,
  ...over,
});
const validation = { skillOK: true, buckets: [{ lo: 0.6, hi: 0.7, n: 60, actual: 0.66, avgPred: 0.65 }, { lo: 0.45, hi: 0.6, n: 60, actual: 0.5, avgPred: 0.52 }] };

test('Solicitud: solo candidatos futuros con datos, ordenados y limitados', () => {
  const ms = [
    mkMatch('a', { probs: { home: 0.55, draw: 0.25, away: 0.2 }, confidence: { tier: null } }),
    mkMatch('b'),
    mkMatch('c', { probs: { home: 0.4, draw: 0.3, away: 0.3 }, confidence: { tier: null } }),
    mkMatch('d', { status: 'FINISHED' }),
    mkMatch('e', { kickoff: new Date(NOW - 3600e3).toISOString() }),
    mkMatch('f', { dataStatus: 'DATOS INSUFICIENTES' }),
  ];
  const c = structuredClone(cfg);
  c.research.maxMatches = 2;
  const req = buildResearchRequest(ms, NOW, c);
  assert.deepEqual(req.matches.map((m) => m.id), ['b', 'a']);
  assert.ok(req.instructions.length >= 5);
  assert.equal(req.validHours, 30);
});

const goodEntry = (over = {}) => ({
  consultedAt: new Date(NOW - 2 * 3600e3).toISOString(),
  injuries: [
    { team: 'home', player: 'Uno', status: 'out', detail: null, source_url: 'https://club.com/parte?x=1', source_date: '2026-11-22' },
    { team: 'home', player: 'Dos', status: 'out', detail: null, source_url: 'https://club.com/parte', source_date: null },
    { team: 'home', player: 'Inventado', status: 'out', detail: null, source_url: 'https://otra.com/x', source_date: null },
  ],
  suspensions: [],
  rotation: { level: 'unknown', team: 'none', reason: null, source_url: null },
  lineup: { confirmed: false, home: [], away: [], source_url: null },
  summary: null,
  sources: [{ url: 'https://club.com/parte', title: 'Parte médico', date: '2026-11-22' }],
  ...over,
});

test('Aplicar: descarta afirmaciones sin fuente, genera advertencia y baja de alta a media sin tocar %', () => {
  const m = mkMatch('b');
  const before = structuredClone(m.probs);
  const info = applyResearch({ file: { provider: 'Claude', matches: { b: goodEntry() } }, matches: [m], now: NOW, cfg, validation });
  assert.equal(info.status, 'ok');
  assert.deepEqual(m.ai.injuries.map((i) => i.player), ['Uno', 'Dos']);
  assert.equal(m.ai.droppedClaims, 1);
  assert.equal(m.ai.provider, 'Claude');
  assert.ok(m.warnings.some((w) => w.ai && w.text.includes('🔴 ADVERTENCIA')));
  assert.equal(m.confidence.tier, 'media');
  assert.deepEqual(m.probs, before);
});

test('Aplicar: investigación vencida, sin fecha o posterior al inicio se ignora', () => {
  const stale = mkMatch('s');
  const nodate = mkMatch('n');
  const late = mkMatch('l', { kickoff: new Date(NOW + 3600e3).toISOString() });
  const file = {
    matches: {
      s: goodEntry({ consultedAt: new Date(NOW - 40 * 3600e3).toISOString() }),
      n: goodEntry({ consultedAt: 'ayer' }),
      l: goodEntry({ consultedAt: new Date(NOW + 2 * 3600e3).toISOString() }),
    },
  };
  const info = applyResearch({ file, matches: [stale, nodate, late], now: NOW, cfg, validation });
  assert.equal(info.status, 'sin_partidos_vigentes');
  for (const m of [stale, nodate, late]) assert.equal(m.ai, null);
  assert.match(info.detail, /vencida/);
});

test('Aplicar: sin fuentes => DATOS INSUFICIENTES; archivo inválido o ausente no rompe', () => {
  const m = mkMatch('x');
  applyResearch({ file: { matches: { x: goodEntry({ sources: [], injuries: [] }) } }, matches: [m], now: NOW, cfg, validation });
  assert.equal(m.ai.status, 'DATOS INSUFICIENTES');
  assert.equal(m.confidence.tier, 'alta');
  assert.equal(applyResearch({ file: null, matches: [m], now: NOW, cfg, validation }).status, 'sin_archivo');
  assert.equal(applyResearch({ file: { invalid: true }, matches: [m], now: NOW, cfg, validation }).status, 'error');
  const d = mkdtempSync(join(tmpdir(), 'rs-'));
  writeFileSync(join(d, 'research.json'), '{roto');
  assert.deepEqual(loadResearch(join(d, 'research.json')), { invalid: true });
  assert.equal(loadResearch(join(d, 'no-existe.json')), null);
});

test('Pipeline: genera research-request.json y aplica research.json vigente sin cambiar probabilidades', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  const out = join(dir, 'out');
  const env = { FOOTBALL_DATA_KEY: 'k' };
  const first = await run({ cfg, env, fetchImpl: fdFetch(), now: NOW, outDir: out, cacheDir: join(dir, 'c'), log: () => {} });
  const req = JSON.parse(readFileSync(join(out, 'research-request.json'), 'utf8'));
  assert.ok(req.matches.length > 0 && req.matches.length <= cfg.research.maxMatches);
  const target = req.matches[0];
  const entry = first.matches.find((m) => m.id === target.id);
  assert.equal(entry.ai, null);

  const research = { schema: 1, provider: 'Claude (prueba)', matches: { [target.id]: goodEntry({ consultedAt: new Date(NOW - 3600e3).toISOString() }) } };
  writeFileSync(join(out, 'research.json'), JSON.stringify(research));
  const second = await run({ cfg, env, fetchImpl: fdFetch(), now: NOW, outDir: out, cacheDir: join(dir, 'c'), log: () => {} });
  assert.deepEqual(validateOutput(second), []);
  const m2 = second.matches.find((m) => m.id === target.id);
  assert.equal(m2.ai.status, 'OK');
  assert.deepEqual(m2.probs, entry.probs);
  assert.notEqual(m2.confidence.tier, 'alta');
  assert.equal(second.sources.find((s) => s.name.startsWith('Investigación')).status, 'ok');
});
