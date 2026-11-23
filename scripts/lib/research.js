// Investigación MANUAL (sustituye a la capa de OpenAI): el programa genera research-request.json,
// el usuario se lo da a Claude, y Claude devuelve research.json con hallazgos verificables
// (bajas, sanciones, rotaciones, alineaciones) y la URL + fecha de cada fuente.
// Se aplican las mismas reglas que a la IA: sin URL citada no hay dato, y NUNCA se tocan los porcentajes.
import { readFileSync, existsSync } from 'node:fs';
import { sanitize, warningsFromAi, normUrl } from './ai.js';
import { applyConfidence } from './pipeline.js';

export const RESEARCH_INSTRUCTIONS = [
  'Para cada partido de "matches", busca en la web SOLO: lesiones, sanciones/suspensiones, posibles rotaciones y alineación confirmada.',
  'Usa información publicada ANTES del inicio del partido. No estimes probabilidades.',
  'Cada lesión/sanción debe llevar source_url (página realmente consultada) y source_date (AAAA-MM-DD) si la página la indica.',
  'Si no encuentras información fiable de un punto, deja la lista vacía o rotation.level = "unknown". No inventes.',
  'Devuelve research.json con: { schema:1, provider, generatedAt, matches:{ "<id>": { consultedAt, injuries[], suspensions[], rotation, lineup, summary, sources[] } } }.',
  'injuries/suspensions: { team:"home"|"away", player, status:"out"|"doubtful", detail, source_url, source_date }.',
  'rotation: { level:"none"|"low"|"high"|"unknown", team:"home"|"away"|"both"|"none", reason, source_url }. lineup: { confirmed, home[], away[], source_url }. sources: [{ url, title, date }].',
];

export function buildResearchRequest(matches, now, cfg) {
  const rc = cfg.research;
  const cand = matches
    .filter((m) => m.dataStatus === 'OK' && m.status !== 'FINISHED' && Date.parse(m.kickoff) > now && (m.confidence.tier || m.probs.home >= rc.minHomeProb))
    .sort((a, b) => b.probs.home - a.probs.home)
    .slice(0, rc.maxMatches);
  return {
    schema: 1,
    generatedAt: new Date(now).toISOString(),
    validHours: rc.validHours,
    instructions: RESEARCH_INSTRUCTIONS,
    matches: cand.map((m) => ({
      id: m.id,
      kickoff: m.kickoff,
      competition: `${m.competition.name} (${m.competition.country})`,
      home: m.home.name,
      away: m.away.name,
      modelHomeProb: +m.probs.home.toFixed(3),
      tier: m.confidence.tier,
    })),
  };
}

export function loadResearch(path) {
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, 'utf8'));
    return f && typeof f === 'object' && f.matches && typeof f.matches === 'object' ? f : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

function toAi(entry, file, kickoffMs) {
  const sources = (Array.isArray(entry.sources) ? entry.sources : []).filter((s) => s && /^https?:\/\//i.test(s.url || ''));
  const citations = new Map(sources.map((s) => [normUrl(s.url), { url: s.url, title: s.title || s.url, date: s.date || null }]));
  const clean = sanitize(
    {
      injuries: entry.injuries,
      suspensions: entry.suspensions,
      rotation: entry.rotation || { level: 'unknown', team: 'none', reason: null, source_url: null },
      lineup: entry.lineup || { confirmed: false, home: [], away: [], source_url: null },
      summary: entry.summary,
    },
    citations,
  );
  // URL canónica de cada afirmación = la de la lista de fuentes
  const canon = (u) => citations.get(normUrl(u))?.url || u;
  clean.injuries.forEach((c) => (c.source_url = canon(c.source_url)));
  clean.suspensions.forEach((c) => (c.source_url = canon(c.source_url)));
  if (clean.rotation.source_url) clean.rotation.source_url = canon(clean.rotation.source_url);
  if (clean.lineup.source_url) clean.lineup.source_url = canon(clean.lineup.source_url);
  const used = new Set(
    [...clean.injuries, ...clean.suspensions].map((c) => normUrl(c.source_url)).concat([normUrl(clean.rotation.source_url), normUrl(clean.lineup.source_url)]),
  );
  const usedSources = [...citations.entries()].filter(([k]) => used.has(k)).map(([, v]) => v);
  const hasFindings = clean.injuries.length || clean.suspensions.length || clean.rotation.level !== 'unknown' || clean.lineup.confirmed;
  return {
    ...clean,
    status: sources.length === 0 ? 'DATOS INSUFICIENTES' : hasFindings ? 'OK' : 'SIN HALLAZGOS VERIFICABLES',
    provider: file.provider || 'Claude (búsqueda web manual)',
    consultedAt: entry.consultedAt,
    sources: usedSources,
  };
}

/** Aplica research.json a los partidos. Devuelve conteos y estado para la sección de fuentes. */
export function applyResearch({ file, matches, now, cfg, validation }) {
  const info = { name: 'Investigación manual (Claude)', url: '', status: 'sin_archivo', detail: 'No hay research.json (opcional)', fetchedAt: null };
  if (!file) return info;
  if (file.invalid) return { ...info, status: 'error', detail: 'research.json no es un JSON válido: se ignora' };
  const maxAge = cfg.research.validHours * 3600e3;
  let applied = 0;
  let expired = 0;
  let rejected = 0;
  let latest = 0;
  for (const m of matches) {
    const e = file.matches[m.id];
    if (!e) continue;
    const at = Date.parse(e.consultedAt);
    if (Number.isNaN(at) || now - at > maxAge || at >= Date.parse(m.kickoff)) {
      // vencida, sin fecha, o consultada después del inicio (no es "minuto 0")
      Number.isNaN(at) || at >= Date.parse(m.kickoff) ? rejected++ : expired++;
      continue;
    }
    if (m.dataStatus !== 'OK' || (m.ai && m.ai.status === 'OK')) continue;
    const ai = toAi(e, file, Date.parse(m.kickoff));
    m.ai = ai;
    m.warnings = m.warnings.filter((w) => !w.ai).concat(warningsFromAi(ai, cfg.ai).map((w) => ({ ...w, ai: true })));
    m.explain = m.explain.filter((l) => !l.startsWith('IA:') && !l.startsWith('Investigación manual:'));
    m.explain.push(
      ai.status === 'OK'
        ? `Investigación manual: ${ai.injuries.length + ai.suspensions.length} baja(s)/sanción(es) con fuente; rotaciones: ${ai.rotation.level}; alineación confirmada: ${ai.lineup.confirmed ? 'sí' : 'no'}. Consultado ${String(ai.consultedAt).slice(0, 10)}.`
        : `Investigación manual: ${ai.status} — bajas, rotaciones y alineaciones: DATOS INSUFICIENTES.`,
    );
    applyConfidence(m, validation, cfg);
    applied++;
    latest = Math.max(latest, at);
  }
  return {
    ...info,
    status: applied ? 'ok' : 'sin_partidos_vigentes',
    detail: `${applied} partido(s) con investigación vigente` + (expired ? `; ${expired} vencida(s) (>${cfg.research.validHours} h)` : '') + (rejected ? `; ${rejected} descartada(s) por fecha` : ''),
    fetchedAt: latest || null,
  };
}
