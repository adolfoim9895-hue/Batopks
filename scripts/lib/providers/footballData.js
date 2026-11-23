// football-data.org v4 (plan gratuito: clave gratis, 10 peticiones/minuto).
// 1 petición por competición y temporada devuelve TODOS los partidos de esa temporada.
const BASE = 'https://api.football-data.org/v4';

export function normalizeFdMatch(m, comp) {
  const season = comp.seasonStart ?? new Date(m.season?.startDate || m.utcDate).getUTCFullYear();
  const finished = m.status === 'FINISHED';
  let gh = null;
  let ga = null;
  let usable = false;
  if (finished) {
    // En eliminatorias fullTime puede incluir prórroga/penales: usamos tiempo reglamentario.
    const s = m.score || {};
    const src = s.duration && s.duration !== 'REGULAR' ? s.regularTime : s.fullTime;
    if (src && src.home != null && src.away != null) {
      gh = src.home;
      ga = src.away;
      usable = true;
    }
  }
  return {
    id: `fd:${m.id}`,
    date: Date.parse(m.utcDate),
    status: m.status,
    season,
    home: { id: `fd:${m.homeTeam.id}`, name: m.homeTeam.shortName || m.homeTeam.name, crest: m.homeTeam.crest || null },
    away: { id: `fd:${m.awayTeam.id}`, name: m.awayTeam.shortName || m.awayTeam.name, crest: m.awayTeam.crest || null },
    gh,
    ga,
    usable,
  };
}

export async function fetchFootballData({ getJson, key, cfg, log = () => {} }) {
  const info = { name: 'football-data.org', url: 'https://www.football-data.org', status: 'sin_clave', detail: '', fetchedAt: null };
  const competitions = [];
  if (!key) {
    info.detail = 'FOOTBALL_DATA_KEY no configurada';
    return { info, competitions };
  }
  const headers = { 'X-Auth-Token': key };
  const opts = { headers, minIntervalMs: cfg.minIntervalMs };
  let ok = 0;
  const errors = [];
  for (const code of cfg.competitions) {
    try {
      const cur = await getJson(`${BASE}/competitions/${code}/matches`, { ...opts, ttlHours: 3 });
      const body = cur.body;
      if (!Array.isArray(body.matches)) throw new Error('respuesta sin partidos');
      info.fetchedAt = Math.max(info.fetchedAt || 0, cur.fetchedAt);
      const startYear = new Date(body.matches[0]?.season?.startDate || body.filters?.season || Date.now()).getUTCFullYear();
      const compMeta = {
        key: code,
        name: body.competition?.name || code,
        country: body.competition?.area?.name || body.matches[0]?.area?.name || '',
        emblem: body.competition?.emblem || null,
        provider: 'football-data.org',
        seasonStart: startYear,
      };
      let matches = body.matches.map((m) => normalizeFdMatch(m, compMeta));
      for (let back = 1; back <= cfg.seasonsBack; back++) {
        try {
          const prev = await getJson(`${BASE}/competitions/${code}/matches?season=${startYear - back}`, { ...opts, ttlHours: 24 * 30 });
          if (Array.isArray(prev.body.matches)) {
            matches = matches.concat(prev.body.matches.map((m) => normalizeFdMatch(m, { ...compMeta, seasonStart: startYear - back })));
          }
        } catch (e) {
          errors.push(`${code} temporada ${startYear - back}: ${e.message}`);
        }
      }
      competitions.push({ ...compMeta, matches });
      ok++;
    } catch (e) {
      errors.push(`${code}: ${e.message}`);
      log(`football-data ${code} falló: ${e.message}`);
    }
  }
  info.status = ok === 0 ? 'error' : errors.length ? 'parcial' : 'ok';
  info.detail = `${ok}/${cfg.competitions.length} competiciones` + (errors.length ? `; fallos: ${errors.slice(0, 5).join(' | ')}` : '');
  return { info, competitions };
}
