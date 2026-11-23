// Historial de pronósticos REALES publicados (antes del partido) y su resultado.
//  - docs/data/history/YYYY-MM.json : un archivo por mes (la app solo descarga el mes que ve).
//  - docs/data/history/summary.json : aciertos acumulados (pequeño). Persiste aunque se borren meses viejos.
// Regla de honestidad: un pronóstico solo se guarda si se vio ANTES del inicio del partido y se congela
// al comenzar; nunca se reescribe con información posterior.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 864e5;
const MONTH_RE = /^(\d{4}-\d{2})\.json$/;
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const outcomeOf = (g) => (g.home > g.away ? 'home' : g.home < g.away ? 'away' : 'draw');
const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

export function snapshot(m, now) {
  return {
    id: m.id,
    kickoff: m.kickoff,
    timeApprox: !!m.timeApprox,
    status: 'SCHEDULED',
    result: null,
    outcome: null,
    hit: null,
    evaluated: false,
    competition: m.competition,
    home: { id: m.home.id, name: m.home.name, crest: m.home.crest },
    away: { id: m.away.id, name: m.away.name, crest: m.away.crest },
    dataStatus: 'OK',
    probs: m.probs,
    xg: m.xg,
    scores: m.scores,
    goals: m.goals,
    favorite: m.favorite,
    confidence: m.confidence,
    warnings: m.warnings || [],
    explain: m.explain || [],
    h2h: m.h2h || [],
    ai: m.ai && m.ai.status === 'OK' ? m.ai : null,
    sources: m.sources || [],
    snapshotAt: new Date(now).toISOString(),
  };
}

const zero = () => ({ n: 0, hits: 0, sumPred: 0 });

export function aggregate(records) {
  const a = { n: 0, hits: 0, byTier: { alta: zero(), media: zero(), none: zero() }, byComp: {} };
  for (const r of records) {
    if (!r.evaluated || r.void || !r.probs) continue;
    const hit = r.hit ? 1 : 0;
    const t = a.byTier[r.confidence?.tier || 'none'];
    const pred = r.probs[r.favorite] ?? 0;
    a.n++;
    a.hits += hit;
    t.n++;
    t.hits += hit;
    t.sumPred += pred;
    const k = r.competition.key;
    a.byComp[k] = a.byComp[k] || { name: r.competition.name, country: r.competition.country, n: 0, hits: 0 };
    a.byComp[k].n++;
    a.byComp[k].hits += hit;
  }
  return a;
}

function addInto(total, a) {
  total.n += a.n;
  total.hits += a.hits;
  for (const t of ['alta', 'media', 'none']) {
    total.byTier[t].n += a.byTier[t].n;
    total.byTier[t].hits += a.byTier[t].hits;
    total.byTier[t].sumPred += a.byTier[t].sumPred;
  }
  for (const [k, v] of Object.entries(a.byComp)) {
    total.byComp[k] = total.byComp[k] || { name: v.name, country: v.country, n: 0, hits: 0 };
    total.byComp[k].n += v.n;
    total.byComp[k].hits += v.hits;
  }
}

/**
 * @param dir carpeta docs/data/history
 * @param matches entradas de predictions.json (ya con IA y confianza finales)
 * @param results Map id -> {home, away} con resultados finales en tiempo reglamentario
 */
export function updateHistory({ dir, matches, results, now, cfg }) {
  const hc = cfg.history || { keepMonths: 24, voidAfterDays: 21 };
  mkdirSync(dir, { recursive: true });
  const months = new Map(); // mes -> {month, matches:{}}
  const dirty = new Set();
  for (const f of readdirSync(dir)) {
    const m = MONTH_RE.exec(f);
    if (m) months.set(m[1], readJson(join(dir, f), { month: m[1], matches: {} }));
  }
  const find = (id) => {
    for (const mo of months.values()) if (mo.matches[id]) return [mo, mo.matches[id]];
    return [null, null];
  };

  // 1) Guardar/actualizar instantáneas PRE-PARTIDO (se congelan al empezar)
  for (const m of matches) {
    if (m.dataStatus !== 'OK' || !m.probs) continue;
    const ko = Date.parse(m.kickoff);
    const [mo, rec] = find(m.id);
    if (rec) {
      if (ko > now && !rec.evaluated) {
        const fresh = snapshot(m, now);
        months.get(monthOf(ko)).matches[m.id] = fresh;
        dirty.add(monthOf(ko));
      }
    } else if (ko > now) {
      const mk = monthOf(ko);
      if (!months.has(mk)) months.set(mk, { month: mk, matches: {} });
      months.get(mk).matches[m.id] = snapshot(m, now);
      dirty.add(mk);
    }
  }

  // 2) Evaluar pendientes con el resultado real
  for (const [mk, mo] of months) {
    for (const rec of Object.values(mo.matches)) {
      if (rec.evaluated || rec.void) continue;
      const res = results.get(rec.id);
      const ko = Date.parse(rec.kickoff);
      if (res && ko < now) {
        rec.result = { home: res.home, away: res.away };
        rec.outcome = outcomeOf(res);
        rec.hit = rec.outcome === rec.favorite;
        rec.status = 'FINISHED';
        rec.evaluated = true;
        dirty.add(mk);
      } else if (now - ko > hc.voidAfterDays * DAY) {
        rec.void = true; // aplazado/cancelado/sin dato: no cuenta ni a favor ni en contra
        dirty.add(mk);
      }
    }
  }

  // 3) Escribir meses modificados
  for (const mk of dirty) writeFileSync(join(dir, `${mk}.json`), JSON.stringify(months.get(mk)));

  // 4) Resumen acumulado: los meses presentes se recalculan; los ya archivados conservan su agregado
  const prev = readJson(join(dir, 'summary.json'), null);
  const byMonth = { ...(prev?.byMonth || {}) };
  let pending = 0;
  for (const [mk, mo] of months) {
    const recs = Object.values(mo.matches);
    byMonth[mk] = aggregate(recs);
    pending += recs.filter((r) => !r.evaluated && !r.void).length;
  }
  const totals = { n: 0, hits: 0, byTier: { alta: zero(), media: zero(), none: zero() }, byComp: {} };
  for (const a of Object.values(byMonth)) addInto(totals, a);
  const summary = {
    schema: 1,
    updatedAt: new Date(now).toISOString(),
    months: [...months.keys()].sort(),
    pending,
    totals,
    byMonth,
    note: 'Aciertos = el resultado favorito del modelo coincidió con el resultado final (tiempo reglamentario). Solo pronósticos guardados antes del inicio del partido.',
  };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary));

  // 5) Retención: se borran archivos mensuales viejos; el resumen conserva sus aciertos
  const d = new Date(now);
  const cutoff = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - hc.keepMonths, 1)).toISOString().slice(0, 7);
  for (const mk of [...months.keys()]) {
    if (mk < cutoff && existsSync(join(dir, `${mk}.json`))) {
      unlinkSync(join(dir, `${mk}.json`));
      months.delete(mk);
    }
  }
  return summary;
}
