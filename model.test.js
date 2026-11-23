import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { poissonPmf, scoreMatrix, summarizeMatch } from '../scripts/lib/poisson.js';
import { fitModel, predict } from '../scripts/lib/model.js';
import { runBacktest } from '../scripts/lib/backtest.js';
import { rng, makeTeams, simulateSeason, normalizedMatches, NOW } from './helpers.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('Poisson: pmf y matriz suman 1, P(0-0)=e^-(λ1+λ2)', () => {
  assert.ok(Math.abs(poissonPmf(1.3, 40).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const m = scoreMatrix(1.4, 1.1, 10);
  assert.ok(Math.abs(m.flat().reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(m[0][0] - Math.exp(-2.5)) < 1e-3);
});

test('Resumen: 1X2 suma 1, over monótono, simetría con λ iguales', () => {
  const s = summarizeMatch(1.2, 1.2);
  assert.ok(Math.abs(s.home + s.draw + s.away - 1) < 1e-9);
  assert.ok(Math.abs(s.home - s.away) < 1e-9);
  assert.ok(s.over05 > s.over15 && s.over15 > s.over25);
  assert.equal(s.topScores.length, 5);
  const strong = summarizeMatch(2.4, 0.6);
  assert.ok(strong.home > 0.75 && strong.btts < 0.5);
});

function league(seed) {
  const r = rng(seed);
  const teams = makeTeams(18, r, 0.3);
  const s1 = simulateSeason(teams, Date.parse('2025-08-01'), 300, NOW, r);
  const s0 = simulateSeason(teams, Date.parse('2024-08-01'), 300, NOW, r);
  const matches = [...normalizedMatches(s0, 2024), ...normalizedMatches(s1, 2025)];
  return { teams, matches };
}

test('El modelo recupera la fuerza real de los equipos (correlación alta)', () => {
  const { teams, matches } = league(7);
  const model = fitModel(matches, NOW, cfg.model);
  const xs = teams.map((t) => Math.log(t.att / t.def));
  const ys = teams.map((t) => Math.log(model.teams.get(`fd:${t.id}`).att / model.teams.get(`fd:${t.id}`).def));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = mean(xs);
  const my = mean(ys);
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const corr = cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  assert.ok(corr > 0.8, `correlación ${corr}`);
});

test('Sin fuga de información: partidos posteriores a asOf no cambian el ajuste', () => {
  const { matches } = league(11);
  const asOf = Date.parse('2025-12-01');
  const a = fitModel(matches, asOf, cfg.model);
  const tampered = matches.map((m) => (m.date >= asOf ? { ...m, gh: 9, ga: 0 } : m));
  const b = fitModel(tampered, asOf, cfg.model);
  for (const [id, t] of a.teams) assert.equal(t.att, b.teams.get(id).att);
});

test('Backtest walk-forward: supera a la referencia y está calibrado', () => {
  const { matches } = league(21);
  const v = runBacktest([{ key: 'SIM', matches }], cfg, NOW);
  assert.ok(v.n > 300, `n=${v.n}`);
  assert.ok(v.brier < v.baselineBrier, `${v.brier} vs ${v.baselineBrier}`);
  assert.equal(v.skillOK, true);
  for (const b of v.buckets.filter((x) => x.n >= 50)) {
    assert.ok(Math.abs(b.actual - b.avgPred) < 0.12, `tramo ${b.lo}-${b.hi}: pred ${b.avgPred} real ${b.actual} n=${b.n}`);
  }
});

test('predict devuelve null para equipos desconocidos', () => {
  const { matches } = league(3);
  const model = fitModel(matches, NOW, cfg.model);
  assert.equal(predict(model, 'fd:9999', 'fd:100', cfg.model), null);
});
