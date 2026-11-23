// Construcción de los pronósticos de la semana a partir de competiciones normalizadas.
import { fitModel, predict } from './model.js';
import { computeTable, teamForm, headToHead } from './stats.js';
import { classify } from './confidence.js';

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const SKIP = new Set(['CANCELLED', 'POSTPONED', 'SUSPENDED']);
const pct = (x) => `${Math.round(x * 100)}%`;

export const startOfUtcDay = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const formView = (f) => ({ n: f.n, w: f.w, d: f.d, l: f.l, gfAvg: +f.gfAvg.toFixed(2), gaAvg: +f.gaAvg.toFixed(2), seq: f.seq });

export function statWarnings(homeForm, homeCount) {
  const w = [];
  if (homeForm.streak.type === 'L' && homeForm.streak.len >= 3) {
    w.push({
      level: 1,
      text: `🔴 ADVERTENCIA: el local acumula ${homeForm.streak.len} derrotas seguidas. El modelo ya las incluye con peso decreciente, pero una racha así reduce el nivel de confianza.`,
    });
  }
  if (homeCount < 10) {
    w.push({ level: 1, text: `🔴 ADVERTENCIA: el local tiene solo ${homeCount} partidos en la base de datos; la estimación es poco estable.` });
  }
  return w;
}

export function analyzeCompetition(comp, order, now, cfg, validation, sourceInfo) {
  const dayStart = startOfUtcDay(now);
  const end = dayStart + (cfg.windowDays + 1) * DAY;
  const train = comp.matches.filter((m) => m.usable && m.date < dayStart);
  const model = train.length >= cfg.model.minCompetitionMatches ? fitModel(train, dayStart, cfg.model) : null;
  const table = computeTable(comp.matches, comp.seasonStart, dayStart);
  const upcoming = comp.matches.filter((m) => m.date >= dayStart && m.date < end && !SKIP.has(m.status));
  const out = [];
  for (const m of upcoming) {
    const entry = {
      id: m.id,
      kickoff: iso(m.date),
      timeApprox: !!m.timeApprox,
      status: m.status,
      result: m.status === 'FINISHED' && m.gh != null ? { home: m.gh, away: m.ga } : null,
      competition: { key: comp.key, name: comp.name, country: comp.country, emblem: comp.emblem, order },
      home: { id: m.home.id, name: m.home.name, crest: m.home.crest },
      away: { id: m.away.id, name: m.away.name, crest: m.away.crest },
      dataStatus: 'OK',
      insufficientReason: null,
      probs: null,
      xg: null,
      scores: [],
      goals: null,
      favorite: null,
      confidence: { tier: null, reason: '', bucket: null },
      warnings: [],
      explain: [],
      h2h: [],
      ai: null,
      sources: [{ name: sourceInfo?.name || comp.provider, url: sourceInfo?.url || '', date: sourceInfo?.fetchedAt ? iso(sourceInfo.fetchedAt) : null }],
    };
    const th = model?.teams.get(m.home.id);
    const ta = model?.teams.get(m.away.id);
    const min = cfg.model.minTeamMatches;
    if (!model || !th || !ta || th.n < min || ta.n < min) {
      entry.dataStatus = 'DATOS INSUFICIENTES';
      entry.insufficientReason = !model
        ? `La competición tiene menos de ${cfg.model.minCompetitionMatches} partidos históricos disponibles`
        : `Algún equipo tiene menos de ${min} partidos históricos (local ${th?.n ?? 0}, visita ${ta?.n ?? 0})`;
      entry.confidence.reason = 'DATOS INSUFICIENTES';
      out.push(entry);
      continue;
    }
    const pr = predict(model, m.home.id, m.away.id, cfg.model);
    entry.probs = { home: pr.home, draw: pr.draw, away: pr.away };
    entry.xg = { home: +pr.xg.home.toFixed(2), away: +pr.xg.away.toFixed(2) };
    entry.scores = pr.topScores.map((s) => ({ score: s.score, p: +s.p.toFixed(4) }));
    entry.goals = { over05: pr.over05, over15: pr.over15, over25: pr.over25, btts: pr.btts };
    entry.favorite = pr.home >= pr.away && pr.home >= pr.draw ? 'home' : pr.away >= pr.draw ? 'away' : 'draw';

    const fN = cfg.model.formMatches;
    const hAll = teamForm(comp.matches, m.home.id, dayStart, fN);
    const aAll = teamForm(comp.matches, m.away.id, dayStart, fN);
    const hHome = teamForm(comp.matches, m.home.id, dayStart, 5, 'H');
    const aAway = teamForm(comp.matches, m.away.id, dayStart, 5, 'A');
    entry.home.rank = table.get(m.home.id) || null;
    entry.away.rank = table.get(m.away.id) || null;
    entry.home.form = formView(hAll);
    entry.home.venueForm = formView(hHome);
    entry.away.form = formView(aAll);
    entry.away.venueForm = formView(aAway);
    entry.h2h = headToHead(comp.matches, m.home.id, m.away.id, dayStart, cfg.model.h2hMatches).map((h) => ({
      date: fmtDate(h.date),
      home: h.home,
      away: h.away,
      score: `${h.gh}-${h.ga}`,
    }));
    entry.warnings = statWarnings(hAll, th.n);

    const ex = entry.explain;
    ex.push(
      `Modelo Poisson con fuerza de ataque/defensa ajustada por rival (${model.nMatches} partidos de la liga, peso decreciente con la antigüedad). Goles esperados: ${m.home.name} ${entry.xg.home} – ${entry.xg.away} ${m.away.name}.`,
    );
    ex.push(`Local en casa (últ. ${hHome.n}): ${hHome.w}V ${hHome.d}E ${hHome.l}D, GF ${hHome.gfAvg.toFixed(1)} / GC ${hHome.gaAvg.toFixed(1)}.`);
    ex.push(`Visita fuera (últ. ${aAway.n}): ${aAway.w}V ${aAway.d}E ${aAway.l}D, GF ${aAway.gfAvg.toFixed(1)} / GC ${aAway.gaAvg.toFixed(1)}.`);
    ex.push(`Forma general (últ. ${hAll.n}): ${m.home.name} ${hAll.seq || '—'} · ${m.away.name} ${aAll.seq || '—'} (reciente primero).`);
    if (entry.home.rank && entry.away.rank) {
      ex.push(`Posición actual: ${m.home.name} ${entry.home.rank.rank}.º, ${m.away.name} ${entry.away.rank.rank}.º de ${entry.home.rank.of}.`);
    }
    ex.push(
      entry.h2h.length
        ? `H2H en la base (${entry.h2h.length}): ${entry.h2h.map((h) => `${h.home} ${h.score} ${h.away}`).join('; ')}. Es informativo: no modifica los % porque su efecto no está validado.`
        : 'H2H: DATOS INSUFICIENTES (sin enfrentamientos recientes en la base).',
    );
    ex.push('Plantilla (Transfermarkt): DATOS INSUFICIENTES — no hay fuente gratuita y legal integrada.');
    out.push(entry);
  }
  return out;
}

export function applyConfidence(entry, validation, cfg) {
  if (entry.dataStatus !== 'OK') return entry;
  const c = classify({ probs: entry.probs, dataOk: true, warnings: entry.warnings }, validation, cfg);
  entry.confidence = { tier: c.tier, reason: c.reason, bucket: c.bucket ? { lo: c.bucket.lo, hi: c.bucket.hi, n: c.bucket.n, actual: c.bucket.actual, avgPred: c.bucket.avgPred } : null };
  // limpia explicación de validación previa y la vuelve a agregar
  entry.explain = entry.explain.filter((l) => !l.startsWith('Validación histórica:'));
  if (c.bucket && c.bucket.n > 0) {
    entry.explain.push(
      `Validación histórica: cuando el modelo dio ${pct(c.bucket.lo)}–${pct(c.bucket.hi)} al local, este ganó ${pct(c.bucket.actual)} de las veces (n=${c.bucket.n}). ${c.reason}.`,
    );
  } else {
    entry.explain.push(`Validación histórica: ${c.reason}.`);
  }
  return entry;
}
