// Lotes manuales: análisis (hechos por Claude a partir de capturas) y resultados.
// Regla de honestidad: nada entra a la app sin fuente verificable, y un análisis solo vale si se hizo ANTES del partido.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const MIN_RECENT = 3; // partidos recientes verificados que se exigen por equipo
const HOUR = 36e5;

export const slug = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    if (!/^https?:$/.test(x.protocol)) return '';
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) x.searchParams.delete(k);
    return (x.protocol + '//' + x.host.toLowerCase() + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase();
  } catch { return ''; }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const str = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const SCORE_RE = /^(\d{1,2})-(\d{1,2})$/;

export function matchId(kickoffIso, home, away) {
  return `${new Date(kickoffIso).toISOString().slice(0, 10)}-${slug(home)}-${slug(away)}`;
}

export function outcomeOf(h, a) { return h > a ? 'home' : h < a ? 'away' : 'draw'; }
export function favoriteOf(p) { return p.home >= p.draw && p.home >= p.away ? 'home' : p.away > p.draw ? 'away' : 'draw'; }

// ---------- análisis ----------
export function normalizeAnalysis(raw, now = Date.now()) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return { match: null, problems: ['entrada no es un objeto'] };
  const home = str(raw.home, 60), away = str(raw.away, 60), competition = str(raw.competition, 80);
  const label = `${home || '?'} vs ${away || '?'}`;
  if (!home || !away || !competition) return { match: null, problems: [`${label}: faltan home, away o competition`] };
  if (!isIso(raw.kickoff)) return { match: null, problems: [`${label}: kickoff inválido (usa ISO UTC, ej. 2026-11-28T20:00:00Z)`] };
  if (!isIso(raw.analyzedAt)) return { match: null, problems: [`${label}: falta analyzedAt`] };
  // origin: 'claude' (por defecto) exige fuentes verificables; cualquier otro origen (p. ej. 'chatgpt') se acepta
  // SIN fuentes, pero queda marcado como no verificado y se contabiliza aparte.
  const origin = (str(raw.origin, 20) || 'claude').toLowerCase();
  const lenient = origin !== 'claude';
  const kick = Date.parse(raw.kickoff);
  const analyzed = Date.parse(raw.analyzedAt);
  if (analyzed >= kick) return { match: null, problems: [`${label}: analizado después del inicio del partido; se descarta (no se puede validar un pronóstico posterior)`] };
  if (analyzed > now + 5 * 60e3) return { match: null, problems: [`${label}: analyzedAt está en el futuro`] };

  // fuentes
  const sources = [];
  const seen = new Set();
  for (const s of Array.isArray(raw.sources) ? raw.sources : []) {
    const n = normUrl(s && s.url);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    sources.push({ url: String(s.url).trim(), title: str(s.title, 120) || String(s.url).trim(), date: isDate(s.date) ? s.date : null });
  }
  const cited = (u) => lenient || seen.has(normUrl(u));

  // evidencia: cada dato debe citar una fuente presente en `sources`
  const dropped = [];
  const keep = (arr, ok, what) => {
    const out = [];
    for (const x of Array.isArray(arr) ? arr : []) {
      if (x && ok(x) && cited(x.source_url)) out.push(x); else dropped.push(what);
    }
    return out;
  };
  const recentOf = (side) => keep(raw.recent && raw.recent[side], (x) => (lenient || isDate(x.date)) && SCORE_RE.test(x.score || '') && str(x.opponent, 60), `forma ${side}`).map((x) => {
    const [gf, ga] = x.score.split('-').map(Number);
    return {
      date: isDate(x.date) ? x.date : null, opponent: str(x.opponent, 60), venue: ['H', 'A', 'N'].includes(x.venue) ? x.venue : null,
      score: x.score, res: gf > ga ? 'W' : gf < ga ? 'L' : 'D', competition: str(x.competition, 60) || null, source_url: x.source_url || null,
    };
  }).sort((a, b) => (a.date && b.date ? (a.date < b.date ? 1 : -1) : 0)).slice(0, 8);
  const recent = { home: recentOf('home'), away: recentOf('away') };
  const h2h = keep(raw.h2h, (x) => (lenient || isDate(x.date)) && SCORE_RE.test(x.score || '') && str(x.home, 60) && str(x.away, 60), 'h2h')
    .map((x) => ({ date: isDate(x.date) ? x.date : null, home: str(x.home, 60), away: str(x.away, 60), score: x.score, competition: str(x.competition, 60) || null, source_url: x.source_url || null }))
    .sort((a, b) => (a.date && b.date ? (a.date < b.date ? 1 : -1) : 0)).slice(0, 6);
  const absOf = (arr, what) => keep(arr, (x) => (x.team === 'home' || x.team === 'away') && str(x.player, 60), what)
    .map((x) => ({ team: x.team, player: str(x.player, 60), status: x.status === 'doubtful' ? 'doubtful' : 'out', detail: str(x.detail, 140), source_url: x.source_url || null, source_date: isDate(x.source_date) ? x.source_date : null }));
  const injuries = absOf(raw.injuries, 'lesión');
  const suspensions = absOf(raw.suspensions, 'sanción');
  if (dropped.length) problems.push(`${label}: se descartaron ${dropped.length} dato(s) sin fuente válida en "sources" (${[...new Set(dropped)].join(', ')})`);

  // cuota del local: solo se registra, nunca entra en las probabilidades
  let homeOdds = null;
  if (raw.homeOdds != null) {
    const o = num(raw.homeOdds);
    if (o !== null && o > 1 && o < 1000) homeOdds = Math.round(o * 100) / 100;
    else problems.push(`${label}: homeOdds debe ser decimal > 1; se ignoró`);
  }

  const match = {
    id: matchId(raw.kickoff, home, away),
    kickoff: new Date(kick).toISOString(),
    competition, country: str(raw.country, 40) || null,
    home, away, homeOdds, origin, verified: !lenient,
    analyzedAt: new Date(analyzed).toISOString(),
    status: 'OK', reason: null,
    probs: null, scores: [], favorite: null,
    reasoning: (Array.isArray(raw.reasoning) ? raw.reasoning : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 8),
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).map((x) => str(x, 220)).filter(Boolean).slice(0, 5),
    recent, h2h, injuries, suspensions, sources,
    result: null, hit: null, scoreHit: null,
  };

  const insufficient = (why) => { match.status = 'DATOS INSUFICIENTES'; match.reason = why; match.probs = null; match.scores = []; match.favorite = null; };
  if (raw.status === 'DATOS INSUFICIENTES') { insufficient(str(raw.reason, 200) || 'Sin información verificable suficiente.'); return { match, problems }; }

  const p = raw.probs || {};
  const ph = num(p.home), pd = num(p.draw), pa = num(p.away);
  if (ph === null || pd === null || pa === null || ph < 0 || pd < 0 || pa < 0) { insufficient('Probabilidades ausentes o inválidas.'); problems.push(`${label}: probs inválidas`); return { match, problems }; }
  const sum = ph + pd + pa;
  if (sum < 0.97 || sum > 1.03) { insufficient('Las probabilidades no suman 100 %.'); problems.push(`${label}: probs suman ${sum.toFixed(2)}`); return { match, problems }; }
  if (!lenient && !sources.length) { insufficient('No hay fuentes citadas.'); return { match, problems }; }
  if (!lenient && (recent.home.length < MIN_RECENT || recent.away.length < MIN_RECENT)) {
    insufficient(`Faltan partidos recientes verificados con fuente (local ${recent.home.length}, visita ${recent.away.length}; mínimo ${MIN_RECENT} por equipo).`);
    return { match, problems };
  }
  match.probs = { home: ph / sum, draw: pd / sum, away: pa / sum };
  match.favorite = favoriteOf(match.probs);
  // origen no verificado: los marcadores pueden venir como "2-1" o {score} sin porcentaje (se respeta el orden dado)
  const rawScores = (Array.isArray(raw.scores) ? raw.scores : []).map((s) => (lenient && typeof s === 'string' ? { score: s } : s));
  match.scores = rawScores
    .filter((s) => s && SCORE_RE.test(s.score || '') && (lenient && num(s.p) === null ? true : num(s.p) !== null && s.p > 0 && s.p < 1))
    .map((s) => ({ score: s.score, p: num(s.p) === null ? null : s.p }));
  if (match.scores.every((s) => s.p !== null)) match.scores.sort((a, b) => b.p - a.p);
  match.scores = match.scores.slice(0, 5);
  return { match, problems };
}

// ---------- resultados ----------
const MIN_RE = /^(\d{1,3})(\+\d{1,2})?$/;
export function normalizeResult(raw, lotCreatedAt) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return { result: null, problems: ['resultado no es un objeto'] };
  const sc = raw.score || {};
  const h = Number.isInteger(sc.home) ? sc.home : null, a = Number.isInteger(sc.away) ? sc.away : null;
  const who = raw.id || `${raw.home || '?'} vs ${raw.away || '?'}`;
  if (h === null || a === null || h < 0 || a < 0 || h > 30 || a > 30) return { result: null, problems: [`${who}: score inválido (usa {home:2, away:1} a los 90 minutos)`] };
  const url = normUrl(raw.source_url) ? String(raw.source_url).trim() : null;
  if (!url && raw.source !== 'captura') return { result: null, problems: [`${who}: falta source_url (o source:"captura" si viene de una captura del usuario)`] };
  let goals = [];
  let bad = false;
  for (const g of Array.isArray(raw.goals) ? raw.goals : []) {
    const m = String(g && g.minute != null ? g.minute : '').replace(/['’′\s]/g, '');
    if (!MIN_RE.test(m) || (g.team !== 'home' && g.team !== 'away')) { bad = true; continue; }
    goals.push({ minute: m, team: g.team, player: str(g.player, 60) || null, type: ['pen', 'og'].includes(g.type) ? g.type : null });
  }
  const minuteVal = (m) => { const [b, e] = m.split('+'); return Number(b) * 100 + Number(e || 0); };
  goals.sort((x, y) => minuteVal(x.minute) - minuteVal(y.minute));
  const nh = goals.filter((g) => g.team === 'home').length, na = goals.filter((g) => g.team === 'away').length;
  if (bad || nh !== h || na !== a) {
    if (h + a > 0) problems.push(`${who}: los minutos de gol no coinciden con el marcador ${h}-${a}; se guardó el resultado sin minutos`);
    goals = [];
  }
  // medio tiempo: el declarado en 'ht' ({home,away}) o, si no viene, el que sale de los minutos de gol (minuto base <= 45, incluye 45+x)
  let ht = null;
  const rh = raw.ht && typeof raw.ht === 'object' ? raw.ht : null;
  if (rh) {
    if (Number.isInteger(rh.home) && Number.isInteger(rh.away) && rh.home >= 0 && rh.away >= 0 && rh.home <= h && rh.away <= a) ht = { home: rh.home, away: rh.away, from: 'declarado' };
    else problems.push(`${who}: medio tiempo inválido (debe ser {home,away} y no mayor al marcador final); se ignora`);
  }
  if (!ht && (h + a === 0 || goals.length > 0)) {
    const first = goals.filter((g) => Number(g.minute.split('+')[0]) <= 45);
    ht = { home: first.filter((g) => g.team === 'home').length, away: first.filter((g) => g.team === 'away').length, from: 'goles' };
  }
  return {
    result: { home: h, away: a, ht, goals, goalsKnown: h + a === 0 || goals.length > 0, source_url: url, source: url ? null : 'captura', source_date: isDate(raw.source_date) ? raw.source_date : null },
    problems,
  };
}

const bucketOf = (p) => (p < 0.45 ? '<45%' : p < 0.55 ? '45-54%' : p < 0.65 ? '55-64%' : '65%+');
const BUCKETS = ['<45%', '45-54%', '55-64%', '65%+'];
const zero = () => ({ n: 0, hits: 0, sumPred: 0 });

export function summarize(matches, now, problems) {
  const totals = { n: 0, hits: 0, sumPred: 0, byPick: { home: zero(), draw: zero(), away: zero() }, byBucket: {}, scoreTop1: { n: 0, hits: 0 }, scoreInList: { n: 0, hits: 0 }, byOrigin: {} };
  for (const b of BUCKETS) totals.byBucket[b] = zero();
  const open = [];
  let insufficient = 0;
  for (const m of matches) {
    if (m.status !== 'OK') { insufficient++; }
    if (!m.result) { open.push({ id: m.id, kickoff: m.kickoff, competition: m.competition, home: m.home, away: m.away, status: m.status }); continue; }
    if (m.status !== 'OK') continue;
    const pred = m.probs[m.favorite];
    totals.n++; totals.sumPred += pred; if (m.hit) totals.hits++;
    const og = m.origin || 'claude'; const ok2 = totals.byOrigin[og] || (totals.byOrigin[og] = zero()); ok2.n++; ok2.sumPred += pred; if (m.hit) ok2.hits++;
    const pk = totals.byPick[m.favorite]; pk.n++; pk.sumPred += pred; if (m.hit) pk.hits++;
    const bk = totals.byBucket[bucketOf(pred)]; bk.n++; bk.sumPred += pred; if (m.hit) bk.hits++;
    if (m.scores.length) { totals.scoreTop1.n++; totals.scoreInList.n++; if (m.scoreHit === 'top') totals.scoreTop1.hits++; if (m.scoreHit) totals.scoreInList.hits++; }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    counts: { total: matches.length, evaluated: totals.n, insufficient, open: open.length },
    totals, open, problems: problems.slice(0, 40),
  };
}

// ---------- construcción completa ----------
export function buildFromLotes(lotes, now = Date.now()) {
  const problems = [];
  const byId = new Map();
  const files = lotes.slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.name.localeCompare(b.name));

  for (const lot of files) {
    for (const raw of Array.isArray(lot.data.matches) ? lot.data.matches : []) {
      const { match, problems: pr } = normalizeAnalysis(raw, now);
      pr.forEach((x) => problems.push(`[${lot.name}] ${x}`));
      if (!match) continue;
      const prev = byId.get(match.id);
      if (prev && Date.parse(prev.analyzedAt) >= Date.parse(match.analyzedAt)) continue; // gana el análisis más reciente anterior al partido
      byId.set(match.id, match);
    }
  }
  const find = (r, createdAt) => {
    if (r.id && byId.has(r.id)) return byId.get(r.id);
    const hs = slug(r.home), as = slug(r.away);
    if (!hs || !as) return null;
    const c = [...byId.values()].filter((m) => slug(m.home) === hs && slug(m.away) === as);
    if (!c.length) return null;
    const ref = isIso(r.kickoff) ? Date.parse(r.kickoff) : Date.parse(createdAt);
    c.sort((x, y) => Math.abs(Date.parse(x.kickoff) - ref) - Math.abs(Date.parse(y.kickoff) - ref));
    return Math.abs(Date.parse(c[0].kickoff) - ref) <= 3 * 24 * HOUR ? c[0] : null;
  };
  for (const lot of files) {
    for (const raw of Array.isArray(lot.data.results) ? lot.data.results : []) {
      const m = find(raw, lot.createdAt);
      const who = raw && (raw.id || `${raw.home} vs ${raw.away}`);
      if (!m) { problems.push(`[${lot.name}] resultado de "${who}": no hay un análisis guardado de ese partido; se ignora`); continue; }
      if (!isIso(lot.createdAt) || Date.parse(lot.createdAt) < Date.parse(m.kickoff)) { problems.push(`[${lot.name}] ${m.home} vs ${m.away}: el lote es anterior al inicio del partido; resultado ignorado`); continue; }
      const { result, problems: pr } = normalizeResult(raw, lot.createdAt);
      pr.forEach((x) => problems.push(`[${lot.name}] ${x}`));
      if (!result) continue;
      m.result = result;
    }
  }
  for (const m of byId.values()) {
    if (!m.result) continue;
    const out = outcomeOf(m.result.home, m.result.away);
    if (m.status === 'OK') {
      m.hit = out === m.favorite;
      const real = `${m.result.home}-${m.result.away}`;
      m.scoreHit = m.scores.length && m.scores[0].score === real ? 'top' : m.scores.some((s) => s.score === real) ? 'list' : null;
    }
  }
  const matches = [...byId.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const months = {};
  for (const m of matches) (months[m.kickoff.slice(0, 7)] = months[m.kickoff.slice(0, 7)] || []).push(m);
  const summary = summarize(matches, now, problems);
  summary.months = Object.keys(months).sort();
  return { months, summary };
}

export function readLotes(dir) {
  const out = [];
  const problems = [];
  if (!existsSync(dir)) return { lotes: out, problems };
  for (const name of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort()) {
    try {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      out.push({ name, createdAt: isIso(data.createdAt) ? data.createdAt : '', data });
    } catch (e) { problems.push(`[${name}] JSON inválido: ${e.message}`); }
  }
  return { lotes: out, problems };
}

export function writeOutput(outDir, built) {
  const dir = join(outDir, 'partidos');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [mk, list] of Object.entries(built.months)) writeFileSync(join(dir, `${mk}.json`), JSON.stringify({ month: mk, matches: list }));
  writeFileSync(join(outDir, 'resumen.json'), JSON.stringify(built.summary));
}
