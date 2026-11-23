// Validación histórica "walk-forward": para cada fecha se ajusta el modelo SOLO con partidos
// anteriores y se predicen los partidos de la semana siguiente. Se mide Brier / log-loss frente a
// una referencia ingenua (frecuencias de 1X2 del entrenamiento) y la calibración de P(local).
import { fitModel, predict } from './model.js';

const DAY = 864e5;
const outcomeOf = (m) => (m.gh > m.ga ? 0 : m.gh === m.ga ? 1 : 2);

export function runBacktest(competitions, cfg, now = Date.now()) {
  const bt = cfg.backtest;
  const rows = []; // {p:[h,d,a], o, base:[h,d,a], comp}
  for (const comp of competitions) {
    const fin = comp.matches
      .filter((m) => m.usable !== false && m.gh != null && m.ga != null && m.date < now)
      .sort((a, b) => a.date - b.date);
    if (fin.length < bt.minTrain + 20) continue;
    let t = fin[bt.minTrain].date;
    const last = fin[fin.length - 1].date;
    while (t <= last) {
      const train = fin.filter((m) => m.date < t);
      const test = fin.filter((m) => m.date >= t && m.date < t + bt.stepDays * DAY);
      if (train.length >= bt.minTrain && test.length) {
        const model = fitModel(train, t, cfg.model);
        if (model) {
          const c = [0, 0, 0];
          for (const m of train) c[outcomeOf(m)]++;
          const base = c.map((x) => x / train.length);
          for (const m of test) {
            const h = model.teams.get(m.home.id);
            const a = model.teams.get(m.away.id);
            if (!h || !a || h.n < bt.minTeamMatches || a.n < bt.minTeamMatches) continue;
            const pr = predict(model, m.home.id, m.away.id, cfg.model);
            rows.push({ p: [pr.home, pr.draw, pr.away], o: outcomeOf(m), base, comp: comp.key });
          }
        }
      }
      t += bt.stepDays * DAY;
    }
  }
  return summarizeBacktest(rows, cfg, now);
}

const brier = (p, o) => p.reduce((s, x, i) => s + (x - (i === o ? 1 : 0)) ** 2, 0);
const logloss = (p, o) => -Math.log(Math.max(p[o], 1e-9));

export function summarizeBacktest(rows, cfg, now = Date.now()) {
  const n = rows.length;
  const out = {
    generatedAt: new Date(now).toISOString(),
    n,
    brier: null,
    baselineBrier: null,
    logLoss: null,
    baselineLogLoss: null,
    skillOK: false,
    buckets: [],
    perCompetition: [],
    method: 'walk-forward semanal; entrenamiento solo con partidos anteriores a cada fecha',
  };
  if (n === 0) return out;
  const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / n;
  out.brier = avg((r) => brier(r.p, r.o));
  out.baselineBrier = avg((r) => brier(r.base, r.o));
  out.logLoss = avg((r) => logloss(r.p, r.o));
  out.baselineLogLoss = avg((r) => logloss(r.base, r.o));
  // El modelo debe superar a la referencia ingenua y tener muestra mínima para considerarse validado.
  out.skillOK = n >= 200 && out.brier < out.baselineBrier && out.logLoss < out.baselineLogLoss;

  const edges = cfg.backtest.buckets;
  for (let i = 0; i < edges.length - 1; i++) {
    const sel = rows.filter((r) => r.p[0] >= edges[i] && r.p[0] < edges[i + 1]);
    out.buckets.push({
      lo: edges[i],
      hi: Math.min(edges[i + 1], 1),
      n: sel.length,
      avgPred: sel.length ? sel.reduce((s, r) => s + r.p[0], 0) / sel.length : null,
      actual: sel.length ? sel.filter((r) => r.o === 0).length / sel.length : null,
    });
  }
  const byComp = new Map();
  for (const r of rows) {
    if (!byComp.has(r.comp)) byComp.set(r.comp, []);
    byComp.get(r.comp).push(r);
  }
  for (const [key, rs] of byComp) {
    out.perCompetition.push({
      key,
      n: rs.length,
      brier: rs.reduce((s, r) => s + brier(r.p, r.o), 0) / rs.length,
      baselineBrier: rs.reduce((s, r) => s + brier(r.base, r.o), 0) / rs.length,
    });
  }
  return out;
}
