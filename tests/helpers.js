// Generador de ligas SIMULADAS solo para pruebas automáticas (nunca se publica ni se muestra en la app).
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function poissonSample(lambda, r) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

export function makeTeams(n, r, sd = 0.3, idBase = 100) {
  return Array.from({ length: n }, (_, i) => ({
    id: idBase + i,
    name: `Equipo ${String.fromCharCode(65 + (i % 26))}${i}`,
    att: Math.exp(gauss(r) * sd),
    def: Math.exp(gauss(r) * sd),
  }));
}

/** Temporada doble vuelta; partidos con date<now terminados (con goles), resto programados. */
export function simulateSeason(teams, startMs, spanDays, now, r, { baseH = 1.5, baseA = 1.15 } = {}) {
  const pairs = [];
  for (const h of teams) for (const a of teams) if (h !== a) pairs.push([h, a]);
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const step = (spanDays * 864e5) / pairs.length;
  return pairs.map(([h, a], i) => {
    const date = startMs + Math.floor(i * step);
    const done = date < now;
    return {
      h,
      a,
      date,
      done,
      gh: done ? poissonSample(baseH * h.att * a.def, r) : null,
      ga: done ? poissonSample(baseA * a.att * h.def, r) : null,
    };
  });
}

export function toFdMatch(m, id, seasonStart) {
  return {
    id,
    utcDate: new Date(m.date).toISOString(),
    status: m.done ? 'FINISHED' : 'SCHEDULED',
    season: { startDate: `${seasonStart}-08-01` },
    homeTeam: { id: m.h.id, name: m.h.name, shortName: m.h.name, crest: null },
    awayTeam: { id: m.a.id, name: m.a.name, shortName: m.a.name, crest: null },
    score: { duration: 'REGULAR', fullTime: { home: m.gh, away: m.ga } },
  };
}

export function normalizedMatches(sim, seasonStart, prefix = 'fd') {
  return sim.map((m, i) => ({
    id: `${prefix}:${seasonStart}-${i}`,
    date: m.date,
    status: m.done ? 'FINISHED' : 'SCHEDULED',
    season: seasonStart,
    home: { id: `${prefix}:${m.h.id}`, name: m.h.name },
    away: { id: `${prefix}:${m.a.id}`, name: m.a.name },
    gh: m.gh,
    ga: m.ga,
    usable: m.done,
  }));
}

export const NOW = Date.parse('2026-11-22T10:00:00Z');
export const jsonRes = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
