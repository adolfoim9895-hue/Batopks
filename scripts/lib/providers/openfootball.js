// openfootball (datos públicos en GitHub, sin clave). Respaldo si football-data.org no responde.
// Limitación: la hora de inicio no es fiable (se marca timeApprox) y la cobertura depende de la comunidad.
const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const seasonDir = (startYear) => `${startYear}-${String(startYear + 1).slice(2)}`;

export function normalizeOfMatches(json, startYear, fileKey) {
  return (json.matches || [])
    .filter((m) => m.date && m.team1 && m.team2)
    .map((m, i) => {
      const t = /^(\d{1,2}):(\d{2})/.exec(m.time || '');
      const iso = `${m.date}T${t ? `${t[1].padStart(2, '0')}:${t[2]}` : '12:00'}:00Z`;
      const ft = m.score?.ft;
      const usable = Array.isArray(ft) && ft.length === 2;
      return {
        id: `of:${fileKey}:${startYear}:${i}`,
        date: Date.parse(iso),
        status: usable ? 'FINISHED' : 'SCHEDULED',
        season: startYear,
        timeApprox: true,
        home: { id: `of:${slug(m.team1)}`, name: m.team1, crest: null },
        away: { id: `of:${slug(m.team2)}`, name: m.team2, crest: null },
        gh: usable ? ft[0] : null,
        ga: usable ? ft[1] : null,
        usable,
      };
    });
}

export async function fetchOpenFootball({ getJson, cfg, now = Date.now(), only = null, log = () => {} }) {
  const info = { name: 'openfootball', url: 'https://github.com/openfootball/football.json', status: 'ok', detail: '', fetchedAt: null };
  const competitions = [];
  const d = new Date(now);
  const startYear = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  let ok = 0;
  const errors = [];
  const files = cfg.files.filter((f) => !only || only(f));
  for (const f of files) {
    let matches = [];
    let gotCurrent = false;
    for (const y of [startYear, startYear - 1]) {
      try {
        const r = await getJson(`${BASE}/${seasonDir(y)}/${f.file}.json`, { ttlHours: y === startYear ? 6 : 24 * 30 });
        info.fetchedAt = Math.max(info.fetchedAt || 0, r.fetchedAt);
        matches = matches.concat(normalizeOfMatches(r.body, y, f.file));
        if (y === startYear) gotCurrent = true;
      } catch (e) {
        errors.push(`${f.file} ${seasonDir(y)}: ${e.message}`);
        log(`openfootball ${f.file} ${y}: ${e.message}`);
      }
    }
    if (gotCurrent && matches.length) {
      competitions.push({ key: f.fd || `of:${f.file}`, name: f.name, country: f.country, emblem: null, provider: 'openfootball', seasonStart: startYear, matches });
      ok++;
    }
  }
  info.status = files.length === 0 ? 'omitido' : ok === 0 ? 'error' : errors.length ? 'parcial' : 'ok';
  info.detail = `${ok}/${files.length} ligas` + (errors.length ? `; avisos: ${errors.slice(0, 4).join(' | ')}` : '');
  return { info, competitions };
}
