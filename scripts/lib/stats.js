// Estadísticas descriptivas: tabla, forma reciente, H2H. Solo usan partidos anteriores a `before`.

const involves = (m, id) => m.home.id === id || m.away.id === id;
const played = (m) => m.gh != null && m.ga != null;

export function computeTable(matches, season, before) {
  const t = new Map();
  const row = (team) => {
    if (!t.has(team.id)) t.set(team.id, { id: team.id, name: team.name, pts: 0, gf: 0, ga: 0, p: 0 });
    return t.get(team.id);
  };
  for (const m of matches) {
    if (m.season !== season || m.date >= before || !played(m)) continue;
    const h = row(m.home);
    const a = row(m.away);
    h.p++;
    a.p++;
    h.gf += m.gh;
    h.ga += m.ga;
    a.gf += m.ga;
    a.ga += m.gh;
    if (m.gh > m.ga) h.pts += 3;
    else if (m.gh < m.ga) a.pts += 3;
    else {
      h.pts++;
      a.pts++;
    }
  }
  const rows = [...t.values()].sort(
    (x, y) => y.pts - x.pts || y.gf - y.ga - (x.gf - x.ga) || y.gf - x.gf || x.name.localeCompare(y.name),
  );
  const rank = new Map();
  rows.forEach((r, i) => rank.set(r.id, { rank: i + 1, of: rows.length, pts: r.pts, p: r.p, gd: r.gf - r.ga }));
  return rank;
}

export function teamForm(matches, teamId, before, n, venue) {
  const list = matches
    .filter((m) => m.date < before && played(m) && involves(m, teamId))
    .filter((m) => (venue === 'H' ? m.home.id === teamId : venue === 'A' ? m.away.id === teamId : true))
    .sort((a, b) => b.date - a.date)
    .slice(0, n);
  let w = 0;
  let d = 0;
  let l = 0;
  let gf = 0;
  let ga = 0;
  const games = list.map((m) => {
    const isHome = m.home.id === teamId;
    const f = isHome ? m.gh : m.ga;
    const c = isHome ? m.ga : m.gh;
    gf += f;
    ga += c;
    const res = f > c ? 'W' : f < c ? 'L' : 'D';
    if (res === 'W') w++;
    else if (res === 'D') d++;
    else l++;
    return { date: m.date, venue: isHome ? 'H' : 'A', opp: isHome ? m.away.name : m.home.name, gf: f, ga: c, res };
  });
  const seq = games.map((g) => g.res).join('');
  let streak = { type: null, len: 0 };
  if (games.length) {
    const t = games[0].res;
    let len = 0;
    for (const g of games) {
      if (g.res === t) len++;
      else break;
    }
    streak = { type: t, len };
  }
  const k = games.length || 1;
  return { n: games.length, w, d, l, gf, ga, gfAvg: gf / k, gaAvg: ga / k, seq, streak, games };
}

export function headToHead(matches, idA, idB, before, n) {
  return matches
    .filter((m) => m.date < before && played(m) && involves(m, idA) && involves(m, idB))
    .sort((a, b) => b.date - a.date)
    .slice(0, n)
    .map((m) => ({ date: m.date, home: m.home.name, away: m.away.name, gh: m.gh, ga: m.ga }));
}
