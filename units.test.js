import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../scripts/lib/confidence.js';
import { validateOutput } from '../scripts/lib/validateOutput.js';
import { sanitize, warningsFromAi, parseResponse, estimateCost } from '../scripts/lib/ai.js';
import { createHttp } from '../scripts/lib/http.js';
import { normalizeFdMatch } from '../scripts/lib/providers/footballData.js';
import { normalizeOfMatches } from '../scripts/lib/providers/openfootball.js';
import { teamForm, computeTable } from '../scripts/lib/stats.js';
import { jsonRes } from './helpers.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const validation = {
  skillOK: true,
  buckets: [
    { lo: 0.45, hi: 0.55, n: 120, avgPred: 0.5, actual: 0.52 },
    { lo: 0.55, hi: 0.65, n: 90, avgPred: 0.6, actual: 0.63 },
    { lo: 0.65, hi: 0.75, n: 60, avgPred: 0.7, actual: 0.72 },
    { lo: 0.75, hi: 1, n: 10, avgPred: 0.8, actual: 0.9 },
  ],
};

test('Confianza: sin validación no hay nivel', () => {
  const c = classify({ probs: { home: 0.7, draw: 0.2, away: 0.1 }, dataOk: true }, { skillOK: false, buckets: [] }, cfg);
  assert.equal(c.tier, null);
  assert.match(c.reason, /validación/i);
});
test('Confianza: alta con tramo validado; baja a media con advertencia nivel 1; ninguna con nivel 2', () => {
  const p = { home: 0.7, draw: 0.2, away: 0.1 };
  assert.equal(classify({ probs: p, dataOk: true }, validation, cfg).tier, 'alta');
  assert.equal(classify({ probs: p, dataOk: true, warnings: [{ level: 1 }] }, validation, cfg).tier, 'media');
  assert.equal(classify({ probs: p, dataOk: true, warnings: [{ level: 2 }] }, validation, cfg).tier, null);
});
test('Confianza: tramo con muestra pequeña (n<40) no puede ser alta; datos insuficientes no tiene nivel', () => {
  const c = classify({ probs: { home: 0.8, draw: 0.12, away: 0.08 }, dataOk: true }, validation, cfg);
  assert.notEqual(c.tier, 'alta');
  assert.equal(classify({ probs: null, dataOk: false }, validation, cfg).tier, null);
});
test('Confianza: local que no es favorito no recibe nivel', () => {
  assert.equal(classify({ probs: { home: 0.34, draw: 0.3, away: 0.36 }, dataOk: true }, validation, cfg).tier, null);
});

test('Validador de salida rechaza 1X2 que no suma 1, nivel sin validación y alta con advertencias', () => {
  const base = {
    schema: 2, generatedAt: new Date().toISOString(), sources: [],
    matches: [{ id: 'a', kickoff: new Date().toISOString(), home: { name: 'A' }, away: { name: 'B' }, dataStatus: 'OK', probs: { home: 0.5, draw: 0.2, away: 0.2 }, xg: { home: 1, away: 1 }, goals: { over05: 0.9, over15: 0.7, over25: 0.4, btts: 0.5 }, scores: [{ score: '1-0', p: 0.1 }], confidence: { tier: null }, warnings: [], sources: [{ name: 'x' }] }],
  };
  assert.ok(validateOutput(base).some((e) => /suma 1/.test(e)));
  base.matches[0].probs = { home: 0.6, draw: 0.2, away: 0.2 };
  assert.deepEqual(validateOutput(base), []);
  base.matches[0].confidence = { tier: 'alta', bucket: null };
  assert.ok(validateOutput(base).some((e) => /sin validación/.test(e)));
  base.matches[0].confidence = { tier: 'alta', bucket: { n: 50 } };
  base.matches[0].warnings = [{ level: 1, text: 'x' }];
  assert.ok(validateOutput(base).some((e) => /advertencias/.test(e)));
  assert.ok(validateOutput({}).length > 0);
});

test('IA: sanitize elimina afirmaciones con URL no citada y warningsFromAi usa umbrales', () => {
  const citations = new Map([['https://a.com/x', { url: 'https://a.com/x', title: 'A' }]]);
  const raw = {
    injuries: [
      { team: 'home', player: 'P1', status: 'out', source_url: 'https://a.com/x?utm=1' },
      { team: 'home', player: 'P2', status: 'out', source_url: 'https://b.com/y' },
    ],
    suspensions: [], rotation: { level: 'high', team: 'home', reason: 'copa', source_url: 'https://b.com/y' }, lineup: { confirmed: true, home: ['x'], away: [], source_url: 'https://b.com/y' },
  };
  const c = sanitize(raw, citations);
  assert.equal(c.injuries.length, 1);
  assert.equal(c.rotation.level, 'unknown');
  assert.equal(c.lineup.confirmed, false);
  assert.ok(c.droppedClaims >= 2);
  const ai = { status: 'OK', injuries: [1, 2, 3, 4].map((i) => ({ team: 'home', player: `J${i}`, status: 'out' })), suspensions: [], rotation: { level: 'none', team: 'none' } };
  assert.equal(warningsFromAi(ai, cfg.ai)[0].level, 2);
  ai.injuries.length = 2;
  assert.equal(warningsFromAi(ai, cfg.ai)[0].level, 1);
  ai.injuries.length = 1;
  assert.equal(warningsFromAi(ai, cfg.ai).length, 0);
  assert.equal(warningsFromAi({ status: 'DATOS INSUFICIENTES' }, cfg.ai).length, 0);
});
test('IA: parseResponse extrae citas y cuenta búsquedas; costo coincide con la tarifa', () => {
  const r = parseResponse({ output: [{ type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '{}', annotations: [{ type: 'url_citation', url: 'https://z.com/' }] }] }], usage: { input_tokens: 1000 } });
  assert.equal(r.searches, 2);
  assert.equal(r.citations.size, 1);
  const cost = estimateCost({ input_tokens: 1e6, output_tokens: 1e6 }, 1000, 'gpt-5-mini', cfg.ai.prices);
  assert.ok(Math.abs(cost - (0.25 + 2 + 10)) < 1e-9);
});

test('HTTP: reintenta en 429 respetando espera y cachea', async () => {
  let n = 0;
  const waits = [];
  const f = async () => (++n === 1 ? { ok: false, status: 429, headers: { get: () => '2' }, json: async () => ({}) } : jsonRes({ ok: 1 }));
  const dir = mkdtempSync(join(tmpdir(), 'h-'));
  const get = createHttp({ cacheDir: dir, fetchImpl: f, sleep: async (ms) => waits.push(ms) });
  const r = await get('https://x.test/a');
  assert.equal(r.body.ok, 1);
  assert.ok(waits.includes(2000));
  const r2 = await get('https://x.test/a');
  assert.equal(r2.fromCache, true);
  assert.equal(n, 2);
});
test('HTTP: error 403 no se reintenta y sin caché lanza error', async () => {
  let n = 0;
  const get = createHttp({ fetchImpl: async () => (n++, jsonRes({}, 403)), sleep: async () => {} });
  await assert.rejects(() => get('https://x.test/b'));
  assert.equal(n, 1);
});

test('Normalizadores: football-data usa tiempo reglamentario en prórroga; openfootball marca hora aproximada', () => {
  const m = normalizeFdMatch({ id: 1, utcDate: '2026-01-01T12:00:00Z', status: 'FINISHED', homeTeam: { id: 1, name: 'A' }, awayTeam: { id: 2, name: 'B' }, score: { duration: 'PENALTY_SHOOTOUT', fullTime: { home: 5, away: 4 }, regularTime: { home: 1, away: 1 } }, season: { startDate: '2025-08-01' } }, {});
  assert.equal(m.gh, 1);
  assert.equal(m.season, 2025);
  const bad = normalizeFdMatch({ id: 2, utcDate: '2026-01-01T12:00:00Z', status: 'FINISHED', homeTeam: { id: 1, name: 'A' }, awayTeam: { id: 2, name: 'B' }, score: { duration: 'EXTRA_TIME', fullTime: { home: 2, away: 1 } }, season: { startDate: '2025-08-01' } }, {});
  assert.equal(bad.usable, false);
  const of = normalizeOfMatches({ matches: [{ date: '2026-11-22', time: '20:00', team1: 'Málaga CF', team2: 'Ñublense', score: { ft: [2, 1] } }, { date: '2026-11-29', team1: 'A', team2: 'B' }] }, 2026, 'es.1');
  assert.equal(of[0].timeApprox, true);
  assert.equal(of[0].home.id, 'of:malaga-cf');
  assert.equal(of[0].usable, true);
  assert.equal(of[1].usable, false);
});

test('Estadísticas: tabla y forma solo con partidos anteriores', () => {
  const mk = (id, h, a, gh, ga, d) => ({ id, season: 2026, date: Date.parse(d), home: { id: h, name: h }, away: { id: a, name: a }, gh, ga, usable: true });
  const ms = [mk(1, 'A', 'B', 2, 0, '2026-09-01'), mk(2, 'B', 'C', 1, 1, '2026-09-08'), mk(3, 'A', 'C', 0, 3, '2026-09-15'), mk(4, 'A', 'B', 9, 9, '2026-12-01')];
  const before = Date.parse('2026-10-01');
  const t = computeTable(ms, 2026, before);
  assert.equal(t.get('C').rank, 1);
  assert.equal(t.get('A').p, 2);
  const f = teamForm(ms, 'A', before, 5);
  assert.equal(f.seq, 'LW');
  assert.equal(f.n, 2);
});

test('Frontend: index.html referencia archivos que existen y no contiene claves', () => {
  const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="(?!https?:|#|data:)([^"?]+)/g)) {
    assert.ok(existsSync(new URL(`../docs/${m[1]}`, import.meta.url)), `falta docs/${m[1]}`);
  }
  for (const f of ['index.html', 'app.js', 'styles.css']) {
    const t = readFileSync(new URL(`../docs/${f}`, import.meta.url), 'utf8');
    assert.ok(!/sk-[A-Za-z0-9]{20,}|X-Auth-Token|OPENAI_API_KEY|x-apisports-key/.test(t), `posible clave en docs/${f}`);
  }
});
