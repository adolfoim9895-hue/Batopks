// Distribución de Poisson y resumen de un partido a partir de goles esperados.

export function poissonPmf(lambda, maxGoals) {
  const out = new Array(maxGoals + 1);
  out[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxGoals; k++) out[k] = (out[k - 1] * lambda) / k;
  return out;
}

/** Matriz [i][j] = P(local i, visita j), renormalizada para sumar 1. */
export function scoreMatrix(lambdaHome, lambdaAway, maxGoals = 10) {
  const ph = poissonPmf(lambdaHome, maxGoals);
  const pa = poissonPmf(lambdaAway, maxGoals);
  let total = 0;
  const m = ph.map((a) =>
    pa.map((b) => {
      const v = a * b;
      total += v;
      return v;
    }),
  );
  return m.map((row) => row.map((v) => v / total));
}

export function summarizeMatch(lambdaHome, lambdaAway, maxGoals = 10, topN = 5) {
  const m = scoreMatrix(lambdaHome, lambdaAway, maxGoals);
  let home = 0;
  let draw = 0;
  let away = 0;
  let btts = 0;
  const totals = new Array(2 * maxGoals + 1).fill(0);
  const scores = [];
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = m[i][j];
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
      if (i > 0 && j > 0) btts += p;
      totals[i + j] += p;
      scores.push({ score: `${i}-${j}`, p });
    }
  }
  const over = (line) => totals.reduce((s, p, g) => (g > line ? s + p : s), 0);
  scores.sort((a, b) => b.p - a.p);
  return {
    home,
    draw,
    away,
    over05: over(0.5),
    over15: over(1.5),
    over25: over(2.5),
    btts,
    topScores: scores.slice(0, topN),
    xg: { home: lambdaHome, away: lambdaAway },
  };
}
