// API-Football (api-sports.io). OPCIONAL. Cubre divisiones menores (Serie B, 2. Bundesliga, MLS...).
// El plan gratuito tiene ~100 peticiones/día y puede restringir temporadas: si la API devuelve
// errores de plan, esa liga se omite sin afectar al resto de la app.
const BASE = 'https://v3.football.api-sports.io';

const seasonFor = (league, nowMs) => {
  const d = new Date(nowMs);
  return league.seasonMode === 'calendar' ? d.getUTCFullYear() : d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

export function normalizeAfFixture(f, season) {
  const short = f.fixture?.status?.short;
  const finished = short === 'FT';
  const ft = f.score?.fulltime;
  const usable = finished && ft?.home != null && ft?.away != null;
  const status = finished ? 'FINISHED' : ['NS', 'TBD'].includes(short) ? 'SCHEDULED' : short === 'PST' ? 'POSTPONED' : short === 'CANC' ? 'CANCELLED' : 'IN_PLAY';
  return {
    id: `af:${f.fixture.id}`,
    date: Date.parse(f.fixture.date),
    status,
    season,
    home: { id: `af:${f.teams.home.id}`, name: f.teams.home.name, crest: f.teams.home.logo || null },
    away: { id: `af:${f.teams.away.id}`, name: f.teams.away.name, crest: f.teams.away.logo || null },
    gh: usable ? ft.home : null,
    ga: usable ? ft.away : null,
    usable,
  };
}

export async function fetchApiFootball({ getJson, key, cfg, now = Date.now(), log = () => {} }) {
  const info = { name: 'API-Football', url: 'https://www.api-football.com', status: 'sin_clave', detail: '', fetchedAt: null };
  const competitions = [];
  if (!key) {
    info.detail = 'API_FOOTBALL_KEY no configurada (opcional)';
    return { info, competitions };
  }
  const headers = { 'x-apisports-key': key };
  let budget = cfg.maxRequestsPerRun;
  let ok = 0;
  const errors = [];
  for (const lg of cfg.leagues) {
    const season = seasonFor(lg, now);
    let matches = [];
    let got = false;
    for (const s of [season, season - 1]) {
      if (budget <= 0) {
        errors.push(`${lg.name}: presupuesto de peticiones agotado`);
        break;
      }
      budget--;
      try {
        const r = await getJson(`${BASE}/fixtures?league=${lg.id}&season=${s}`, {
          headers,
          ttlHours: s === season ? 6 : 24 * 30,
          minIntervalMs: 1100,
        });
        const errs = r.body.errors;
        if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
          throw new Error(JSON.stringify(errs).slice(0, 120));
        }
        info.fetchedAt = Math.max(info.fetchedAt || 0, r.fetchedAt);
        matches = matches.concat((r.body.response || []).map((f) => normalizeAfFixture(f, s)));
        got = got || s === season;
      } catch (e) {
        errors.push(`${lg.name} ${s}: ${e.message}`);
        log(`API-Football ${lg.name} ${s}: ${e.message}`);
      }
    }
    if (got && matches.length) {
      competitions.push({ key: `af:${lg.id}`, name: lg.name, country: lg.country, emblem: null, provider: 'API-Football', seasonStart: season, matches });
      ok++;
    }
  }
  info.status = ok === 0 ? 'error' : errors.length ? 'parcial' : 'ok';
  info.detail = `${ok}/${cfg.leagues.length} ligas` + (errors.length ? `; avisos: ${errors.slice(0, 4).join(' | ')}` : '');
  return { info, competitions };
}
