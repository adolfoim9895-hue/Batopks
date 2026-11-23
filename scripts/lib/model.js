// Modelo de goles: Poisson con fuerza de ataque/defensa ajustada por rival,
// peso decreciente con la antigüedad y contracción hacia 1 (evita extremos con pocos partidos).
//   λ_local  = base · HA · ataque_local · defensa_visita
//   λ_visita = base / HA · ataque_visita · defensa_local
import { summarizeMatch } from './poisson.js';

const DAY = 864e5;

/**
 * @param {Array<{home:{id:string},away:{id:string},gh:number,ga:number,date:number}>} matches partidos terminados
 * @param {number} asOf ms: solo se usan partidos con fecha < asOf (sin fuga de información)
 */
export function fitModel(matches, asOf, cfg) {
  const halfLife = cfg.halfLifeDays * DAY;
  const ms = [];
  for (const m of matches) {
    if (m.date >= asOf || m.gh == null || m.ga == null) continue;
    ms.push({
      h: m.home.id,
      a: m.away.id,
      gh: m.gh,
      ga: m.ga,
      w: Math.pow(0.5, (asOf - m.date) / halfLife),
    });
  }
  if (ms.length === 0) return null;

  let W = 0;
  let sh = 0;
  let sa = 0;
  for (const m of ms) {
    W += m.w;
    sh += m.w * m.gh;
    sa += m.w * m.ga;
  }
  const muH = Math.max(sh / W, 0.2);
  const muA = Math.max(sa / W, 0.2);
  const base = Math.sqrt(muH * muA);
  const ha = Math.sqrt(muH / muA);

  const teams = new Map();
  const get = (id) => {
    let t = teams.get(id);
    if (!t) {
      t = { att: 1, def: 1, n: 0, nHome: 0, nAway: 0 };
      teams.set(id, t);
    }
    return t;
  };
  for (const m of ms) {
    const h = get(m.h);
    const a = get(m.a);
    h.n++;
    h.nHome++;
    a.n++;
    a.nAway++;
  }

  const K = cfg.shrinkK;
  const ids = [...teams.keys()];
  for (let it = 0; it < cfg.iterations; it++) {
    // ataque
    const nA = new Map(ids.map((i) => [i, K]));
    const dA = new Map(ids.map((i) => [i, K]));
    for (const m of ms) {
      nA.set(m.h, nA.get(m.h) + m.w * m.gh);
      dA.set(m.h, dA.get(m.h) + m.w * base * ha * teams.get(m.a).def);
      nA.set(m.a, nA.get(m.a) + m.w * m.ga);
      dA.set(m.a, dA.get(m.a) + (m.w * base * teams.get(m.h).def) / ha);
    }
    for (const i of ids) teams.get(i).att = nA.get(i) / dA.get(i);
    // defensa (goles recibidos)
    const nD = new Map(ids.map((i) => [i, K]));
    const dD = new Map(ids.map((i) => [i, K]));
    for (const m of ms) {
      nD.set(m.a, nD.get(m.a) + m.w * m.gh);
      dD.set(m.a, dD.get(m.a) + m.w * base * ha * teams.get(m.h).att);
      nD.set(m.h, nD.get(m.h) + m.w * m.ga);
      dD.set(m.h, dD.get(m.h) + (m.w * base * teams.get(m.a).att) / ha);
    }
    for (const i of ids) teams.get(i).def = nD.get(i) / dD.get(i);
    // normalización (media = 1)
    const mA = ids.reduce((s, i) => s + teams.get(i).att, 0) / ids.length;
    const mD = ids.reduce((s, i) => s + teams.get(i).def, 0) / ids.length;
    for (const i of ids) {
      teams.get(i).att /= mA;
      teams.get(i).def /= mD;
    }
  }
  return { base, ha, muH, muA, teams, nMatches: ms.length, asOf };
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function expectedGoals(model, homeId, awayId) {
  const h = model.teams.get(homeId);
  const a = model.teams.get(awayId);
  if (!h || !a) return null;
  return {
    home: clamp(model.base * model.ha * h.att * a.def, 0.15, 4.5),
    away: clamp((model.base / model.ha) * a.att * h.def, 0.15, 4.5),
  };
}

export function predict(model, homeId, awayId, cfg) {
  const xg = expectedGoals(model, homeId, awayId);
  if (!xg) return null;
  return summarizeMatch(xg.home, xg.away, cfg.maxGoals);
}
