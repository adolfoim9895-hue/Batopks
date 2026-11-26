import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { normalizeAnalysis, normalizeResult, buildFromLotes, readLotes, writeOutput, matchId, slug, MIN_RECENT } from '../scripts/lib/lotes.js';

const guide = JSON.parse(readFileSync(new URL('../docs/data/guia-claude.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-12-03T19:00:00Z');
const clone = (x) => JSON.parse(JSON.stringify(x));
const lot = (name, data) => ({ name, createdAt: data.createdAt || '', data });
const sampleMatch = () => clone(guide.ejemplo_lote_analisis.matches[0]);

test('los ejemplos de la guía pasan el validador (la guía no miente)', () => {
  const { match, problems } = normalizeAnalysis(sampleMatch(), NOW);
  assert.equal(problems.length, 0);
  assert.equal(match.status, 'OK');
  assert.equal(match.favorite, 'home');
  assert.equal(match.id, '2026-12-05-club-alfa-club-beta');
  const sum = match.probs.home + match.probs.draw + match.probs.away;
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const { result, problems: pr } = normalizeResult(guide.ejemplo_lote_resultados.results[0], '2026-12-05T23:10:00Z');
  assert.equal(pr.length, 0);
  assert.deepEqual(result.goals.map((g) => g.minute), ['23', '55', '78']);
});

test('un análisis hecho después del inicio se descarta', () => {
  const m = sampleMatch(); m.analyzedAt = '2026-12-05T20:01:00Z';
  const r = normalizeAnalysis(m, Date.parse('2026-12-05T21:00:00Z'));
  assert.equal(r.match, null);
  assert.match(r.problems[0], /después del inicio/);
});

test('datos sin fuente citada en "sources" se descartan y puede quedar DATOS INSUFICIENTES', () => {
  const m = sampleMatch();
  m.recent.home.forEach((x) => { x.source_url = 'https://otra.web/no-citada'; });
  const { match, problems } = normalizeAnalysis(m, NOW);
  assert.equal(match.status, 'DATOS INSUFICIENTES');
  assert.equal(match.probs, null);
  assert.match(match.reason, /recientes verificados/);
  assert.ok(problems.some((p) => /sin fuente válida/.test(p)));
});

test('sin fuentes no hay porcentajes', () => {
  const m = sampleMatch(); m.sources = [];
  const { match } = normalizeAnalysis(m, NOW);
  assert.equal(match.status, 'DATOS INSUFICIENTES');
  assert.equal(match.probs, null);
});

test('probabilidades que no suman 100 % no se publican; mínimo de partidos recientes', () => {
  const m = sampleMatch(); m.probs = { home: 0.7, draw: 0.3, away: 0.3 };
  assert.equal(normalizeAnalysis(m, NOW).match.status, 'DATOS INSUFICIENTES');
  const k = sampleMatch(); k.recent.away = k.recent.away.slice(0, MIN_RECENT - 1);
  assert.equal(normalizeAnalysis(k, NOW).match.status, 'DATOS INSUFICIENTES');
  const d = sampleMatch(); d.status = 'DATOS INSUFICIENTES'; d.reason = 'sin datos'; delete d.probs;
  const r = normalizeAnalysis(d, NOW).match;
  assert.equal(r.status, 'DATOS INSUFICIENTES'); assert.equal(r.reason, 'sin datos');
});

test('la cuota del local se registra pero nunca cambia las probabilidades', () => {
  const a = normalizeAnalysis(sampleMatch(), NOW).match;
  const m = sampleMatch(); m.homeOdds = 7.5;
  const b = normalizeAnalysis(m, NOW).match;
  assert.equal(b.homeOdds, 7.5);
  assert.deepEqual(a.probs, b.probs);
  const bad = sampleMatch(); bad.homeOdds = 0.5;
  assert.equal(normalizeAnalysis(bad, NOW).match.homeOdds, null);
});

test('resultado: minutos incoherentes con el marcador se descartan, el resultado se conserva', () => {
  const r = clone(guide.ejemplo_lote_resultados.results[0]); r.goals.pop();
  const { result, problems } = normalizeResult(r, '2026-12-05T23:10:00Z');
  assert.equal(result.home, 2); assert.deepEqual(result.goals, []);
  assert.ok(problems.length === 1);
  assert.equal(normalizeResult({ score: { home: 1, away: 0 }, goals: [{ minute: '10', team: 'home' }] }, 'x').result, null); // sin fuente
  const cap = normalizeResult({ score: { home: 1, away: 0 }, goals: [{ minute: "45+2'", team: 'home' }], source: 'captura' }, 'x').result;
  assert.equal(cap.goals[0].minute, '45+2');
});

test('construcción: aciertos, pendientes y orden de lotes', () => {
  const lotA = lot('lote-a.json', { createdAt: '2026-12-03T18:05:00Z', matches: [sampleMatch()] });
  const lotR = lot('lote-b.json', clone(guide.ejemplo_lote_resultados));
  const built = buildFromLotes([lotR, lotA], Date.parse('2026-12-06T00:00:00Z')); // el orden de entrada no importa
  const m = built.months['2026-12'][0];
  assert.equal(m.hit, true);
  assert.equal(m.scoreHit, 'list');
  assert.equal(built.summary.totals.n, 1); assert.equal(built.summary.totals.hits, 1);
  assert.equal(built.summary.totals.byPick.home.hits, 1);
  assert.equal(built.summary.open.length, 0);
  const again = buildFromLotes([lotA, lotR], Date.parse('2026-12-06T00:00:00Z'));
  assert.deepEqual(again.months, built.months);
});

test('resultado de un lote anterior al partido o sin análisis previo se ignora', () => {
  const lotA = lot('a.json', { createdAt: '2026-12-03T18:05:00Z', matches: [sampleMatch()] });
  const early = clone(guide.ejemplo_lote_resultados); early.createdAt = '2026-12-04T10:00:00Z';
  let b = buildFromLotes([lotA, lot('r.json', early)], NOW);
  assert.equal(b.months['2026-12'][0].result, null);
  assert.ok(b.summary.problems.some((p) => /anterior al inicio/.test(p)));
  b = buildFromLotes([lot('r.json', clone(guide.ejemplo_lote_resultados))], NOW);
  assert.equal(Object.keys(b.months).length, 0);
  assert.ok(b.summary.problems.some((p) => /no hay un análisis/.test(p)));
});

test('un nuevo análisis previo al partido reemplaza al anterior; nunca uno más viejo', () => {
  const a1 = sampleMatch(); a1.analyzedAt = '2026-12-03T12:00:00Z';
  const a2 = sampleMatch(); a2.analyzedAt = '2026-12-04T12:00:00Z'; a2.probs = { home: 0.4, draw: 0.3, away: 0.3 };
  const b = buildFromLotes([lot('x.json', { createdAt: '2026-12-04T12:05:00Z', matches: [a2] }), lot('y.json', { createdAt: '2026-12-03T12:05:00Z', matches: [a1] })], Date.parse('2026-12-04T13:00:00Z'));
  assert.equal(b.months['2026-12'].length, 1);
  assert.ok(Math.abs(b.months['2026-12'][0].probs.home - 0.4) < 1e-9);
});

test('lectura/escritura de disco; lote con JSON roto no tumba el resto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-'));
  const lotes = join(dir, 'lotes'); mkdirSync(lotes);
  writeFileSync(join(lotes, 'ok.json'), JSON.stringify({ createdAt: '2026-12-03T18:05:00Z', matches: [sampleMatch()] }));
  writeFileSync(join(lotes, 'roto.json'), '{ esto no es json');
  const { lotes: ls, problems } = readLotes(lotes);
  assert.equal(ls.length, 1); assert.match(problems[0], /JSON inválido/);
  const built = buildFromLotes(ls, NOW);
  writeOutput(dir, built);
  assert.ok(existsSync(join(dir, 'resumen.json')));
  assert.deepEqual(readdirSync(join(dir, 'partidos')), ['2026-12.json']);
  const month = JSON.parse(readFileSync(join(dir, 'partidos', '2026-12.json'), 'utf8'));
  assert.equal(month.matches.length, 1);
  const res = JSON.parse(readFileSync(join(dir, 'resumen.json'), 'utf8'));
  assert.equal(res.open.length, 1);
});

test('ids estables', () => {
  assert.equal(slug('Atlético  de Madrid'), 'atletico-de-madrid');
  assert.equal(matchId('2026-12-05T20:00:00Z', 'Club Alfa', 'Club Beta'), '2026-12-05-club-alfa-club-beta');
});

// ---------- Excel ----------
function loadRLX() {
  const code = readFileSync(new URL('../docs/xlsx.js', import.meta.url), 'utf8');
  const sb = { TextEncoder, Uint8Array, Intl, Date, Math, Number, String, Array, Object, isFinite };
  sb.globalThis = sb;
  vm.runInNewContext(code, sb);
  return sb.RLX;
}
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let e = buf.length - 22;
  assert.equal(dv.getUint32(e, true), 0x06054b50);
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nl)).toString('utf8');
    const lnl = dv.getUint16(off + 26, true);
    const data = buf.subarray(off + 30 + lnl, off + 30 + lnl + size);
    out[name] = { data, crc };
    p += 46 + nl;
  }
  return out;
}

test('Excel: .xlsx válido (zip con CRC correcto) con fecha, torneo, equipos, cuota y minutos de gol', () => {
  const RLX = loadRLX();
  const lotA = lot('a.json', { createdAt: '2026-12-03T18:05:00Z', matches: [sampleMatch()] });
  const lotR = lot('r.json', clone(guide.ejemplo_lote_resultados));
  const m = buildFromLotes([lotA, lotR], Date.parse('2026-12-06T00:00:00Z')).months['2026-12'];
  const rows = RLX.matchesToRows(m, 'America/Tijuana');
  assert.equal(rows[0][6], 'Cuota local (antes del partido)');
  const r = rows[1];
  assert.equal(r[0], '2026-12-05'); assert.equal(r[1], '12:00'); // 20:00Z = 12:00 en Tijuana (UTC-8)
  assert.equal(r[2], 'Liga Ejemplo'); assert.equal(r[4], 'Club Alfa'); assert.equal(r[5], 'Club Beta');
  assert.equal(r[6].v, 1.85);
  assert.equal(r[13], "23', 78' (p)"); assert.equal(r[14], "55'");
  assert.equal(r[15], "1-0 (23') · 1-1 (55') · 2-1 (78')");
  assert.equal(r[17], 'SÍ');
  const bytes = RLX.makeXlsx(rows, RLX.WIDTHS, 'Partidos');
  const files = readZip(bytes);
  for (const [name, f] of Object.entries(files)) assert.equal(RLX.crc32(f.data), f.crc, name);
  assert.ok(files['xl/worksheets/sheet1.xml'] && files['xl/styles.xml'] && files['[Content_Types].xml']);
  const sheet = Buffer.from(files['xl/worksheets/sheet1.xml'].data).toString('utf8');
  assert.match(sheet, /Club Alfa/); assert.match(sheet, /<v>1.85<\/v>/);
  if (process.env.XLSX_OUT) writeFileSync(process.env.XLSX_OUT, bytes);
});

test('la app no contiene claves ni llamadas a APIs externas', () => {
  for (const f of ['../docs/app.js', '../docs/index.html', '../docs/xlsx.js']) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(t, /api[_-]?key|FOOTBALL_DATA|OPENAI|Authorization|X-Auth-Token/i, f);
  }
  const app = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /fetch\(\s*['"]https?:/, 'solo se piden archivos propios');
});
