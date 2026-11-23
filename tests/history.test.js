import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateHistory } from '../scripts/lib/history.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const T0 = Date.parse('2026-11-23T10:00:00Z');
const H = 3600e3;
const entry = (id, koMs, over = {}) => ({
  id,
  kickoff: new Date(koMs).toISOString(),
  competition: { key: 'PL', name: 'Premier League', country: 'England', order: 0 },
  home: { id: 'h' + id, name: 'Local ' + id, crest: null },
  away: { id: 'a' + id, name: 'Visita ' + id, crest: null },
  dataStatus: 'OK',
  probs: { home: 0.65, draw: 0.2, away: 0.15 },
  xg: { home: 1.8, away: 0.7 },
  scores: [{ score: '2-0', p: 0.12 }],
  goals: { over05: 0.9, over15: 0.7, over25: 0.4, btts: 0.4 },
  favorite: 'home',
  confidence: { tier: 'alta', reason: 'x', bucket: { n: 50 } },
  warnings: [],
  explain: [],
  sources: [{ name: 'fd' }],
  ...over,
});
const dir = () => join(mkdtempSync(join(tmpdir(), 'hist-')), 'history');
const read = (d, f) => JSON.parse(readFileSync(join(d, f), 'utf8'));

test('Historial: guarda pre-partido, congela al empezar y evalúa con el resultado real', () => {
  const d = dir();
  const res = new Map();
  updateHistory({ dir: d, matches: [entry('1', T0 + 5 * H)], results: res, now: T0, cfg });
  assert.equal(read(d, '2026-11.json').matches['1'].evaluated, false);

  // ya empezó: aunque cambie el pronóstico no se reescribe
  const changed = entry('1', T0 + 5 * H, { probs: { home: 0.2, draw: 0.2, away: 0.6 }, favorite: 'away' });
  updateHistory({ dir: d, matches: [changed], results: res, now: T0 + 6 * H, cfg });
  assert.equal(read(d, '2026-11.json').matches['1'].favorite, 'home');

  // termina 2-1 → acierto
  res.set('1', { home: 2, away: 1 });
  const s = updateHistory({ dir: d, matches: [], results: res, now: T0 + 9 * H, cfg });
  const r = read(d, '2026-11.json').matches['1'];
  assert.equal(r.hit, true);
  assert.equal(r.outcome, 'home');
  assert.deepEqual(r.result, { home: 2, away: 1 });
  assert.equal(s.totals.n, 1);
  assert.equal(s.totals.byTier.alta.hits, 1);
  assert.equal(s.pending, 0);
});

test('Historial: un partido visto por primera vez ya empezado NO se registra', () => {
  const d = dir();
  const s = updateHistory({ dir: d, matches: [entry('2', T0 - 2 * H)], results: new Map(), now: T0, cfg });
  assert.equal(readdirSync(d).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).length, 0);
  assert.equal(s.totals.n, 0);
});

test('Historial: fallos, empates y "sin nivel" se cuentan bien; un archivo por mes', () => {
  const d = dir();
  const res = new Map([['a', { home: 0, away: 1 }], ['b', { home: 1, away: 1 }], ['c', { home: 3, away: 0 }]]);
  const ms = [
    entry('a', T0 + 2 * H),
    entry('b', T0 + 3 * H, { confidence: { tier: 'media', reason: '', bucket: { n: 40 } } }),
    entry('c', T0 + 4 * H, { confidence: { tier: null, reason: '', bucket: null } }),
    entry('d', Date.parse('2026-12-02T15:00:00Z')),
  ];
  updateHistory({ dir: d, matches: ms, results: new Map(), now: T0, cfg });
  assert.deepEqual(readdirSync(d).sort(), ['2026-11.json', '2026-12.json', 'summary.json']);
  const s = updateHistory({ dir: d, matches: [], results: res, now: T0 + 10 * H, cfg });
  assert.equal(s.totals.n, 3);
  assert.equal(s.totals.hits, 1);
  assert.equal(s.totals.byTier.alta.hits, 0);
  assert.equal(s.totals.byTier.media.n, 1);
  assert.equal(s.totals.byTier.none.hits, 1);
  assert.equal(s.pending, 1);
  assert.ok(Math.abs(s.totals.byTier.alta.sumPred - 0.65) < 1e-9);
});

test('Historial: partidos sin resultado tras 21 días se anulan; retención conserva los aciertos del resumen', () => {
  const d = dir();
  const res = new Map([['old', { home: 1, away: 0 }]]);
  updateHistory({ dir: d, matches: [entry('old', T0 + H), entry('lost', T0 + 2 * H)], results: new Map(), now: T0, cfg });
  const later = T0 + 30 * 864e5;
  const s = updateHistory({ dir: d, matches: [], results: res, now: later, cfg });
  const m = read(d, '2026-11.json').matches;
  assert.equal(m.lost.void, true);
  assert.equal(s.totals.n, 1);
  assert.equal(s.pending, 0);
  // 3 años después: se borra el archivo mensual, el resumen mantiene el acierto
  const far = Date.parse('2029-12-01T00:00:00Z');
  const s2 = updateHistory({ dir: d, matches: [], results: new Map(), now: far, cfg });
  assert.ok(!readdirSync(d).includes('2026-11.json'));
  assert.equal(s2.totals.n, 1);
  assert.equal(s2.totals.hits, 1);
});

test('Historial: archivo mensual dañado no rompe la actualización', () => {
  const d = dir();
  updateHistory({ dir: d, matches: [entry('1', T0 + H)], results: new Map(), now: T0, cfg });
  writeFileSync(join(d, '2026-11.json'), '{no es json');
  const s = updateHistory({ dir: d, matches: [entry('2', T0 + 2 * H)], results: new Map(), now: T0, cfg });
  assert.equal(s.pending, 1);
});
