// Capa de IA OPCIONAL (OpenAI Responses API + web_search). La IA NO calcula probabilidades.
// Solo investiga bajas, sanciones, rotaciones y alineaciones. Cada afirmación debe citar una URL que
// realmente aparezca en las citas de la búsqueda; si no, se descarta. Sin citas => DATOS INSUFICIENTES.

const URL_API = 'https://api.openai.com/v1/responses';

const nullableStr = { type: ['string', 'null'] };
const claim = {
  type: 'object',
  additionalProperties: false,
  required: ['team', 'player', 'status', 'detail', 'source_url', 'source_date'],
  properties: {
    team: { type: 'string', enum: ['home', 'away'] },
    player: { type: 'string' },
    status: { type: 'string', enum: ['out', 'doubtful'] },
    detail: nullableStr,
    source_url: { type: 'string' },
    source_date: nullableStr,
  },
};
export const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['injuries', 'suspensions', 'rotation', 'lineup', 'summary'],
  properties: {
    injuries: { type: 'array', items: claim },
    suspensions: { type: 'array', items: claim },
    rotation: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'team', 'reason', 'source_url'],
      properties: {
        level: { type: 'string', enum: ['none', 'low', 'high', 'unknown'] },
        team: { type: 'string', enum: ['home', 'away', 'both', 'none'] },
        reason: nullableStr,
        source_url: nullableStr,
      },
    },
    lineup: {
      type: 'object',
      additionalProperties: false,
      required: ['confirmed', 'home', 'away', 'source_url'],
      properties: {
        confirmed: { type: 'boolean' },
        home: { type: 'array', items: { type: 'string' } },
        away: { type: 'array', items: { type: 'string' } },
        source_url: nullableStr,
      },
    },
    summary: nullableStr,
  },
};

export function buildPrompt(entry, todayISO) {
  return [
    `Fecha de hoy: ${todayISO}. Investiga con búsqueda web este partido de fútbol que aún NO ha empezado:`,
    `${entry.home.name} (local) vs ${entry.away.name} (visita) — ${entry.competition.name}, ${entry.kickoff}.`,
    'Busca SOLO: lesiones, sanciones/suspensiones, posibles rotaciones y alineación confirmada (si ya se publicó).',
    'Reglas estrictas:',
    '- No inventes nada. Si no encuentras información fiable y reciente sobre un punto, deja la lista vacía o usa "unknown".',
    '- Cada lesión/sanción debe incluir source_url de una página que realmente consultaste y source_date (AAAA-MM-DD) si la página la indica, o null.',
    '- No estimes probabilidades ni des pronósticos. No uses información posterior al inicio del partido.',
    '- Responde únicamente con el JSON del esquema.',
  ].join('\n');
}

const normUrl = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

export function parseResponse(resp) {
  const citations = new Map();
  let text = '';
  let searches = 0;
  for (const item of resp.output || []) {
    if (item.type === 'web_search_call') searches++;
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') {
          text += c.text;
          for (const a of c.annotations || []) {
            if (a.type === 'url_citation' && a.url) citations.set(normUrl(a.url), { url: a.url, title: a.title || a.url });
          }
        }
      }
    }
  }
  return { text, citations, searches, usage: resp.usage || {} };
}

/** Descarta afirmaciones cuya URL no esté entre las citas reales de la búsqueda. */
export function sanitize(raw, citations) {
  let dropped = 0;
  const ok = (url) => url && citations.has(normUrl(url));
  const keep = (arr) =>
    (Array.isArray(arr) ? arr : []).filter((c) => {
      const good = c && c.player && ok(c.source_url);
      if (!good) dropped++;
      return good;
    });
  const rot = raw.rotation && ok(raw.rotation.source_url) ? raw.rotation : { level: 'unknown', team: 'none', reason: null, source_url: null };
  if (raw.rotation && raw.rotation.level !== 'unknown' && raw.rotation.level !== 'none' && !ok(raw.rotation.source_url)) dropped++;
  const lu = raw.lineup && raw.lineup.confirmed && ok(raw.lineup.source_url) ? raw.lineup : { confirmed: false, home: [], away: [], source_url: null };
  return { injuries: keep(raw.injuries), suspensions: keep(raw.suspensions), rotation: rot, lineup: lu, summary: raw.summary || null, droppedClaims: dropped };
}

export function estimateCost(usage, searches, model, prices) {
  const p = prices[model] || prices['gpt-5-mini'];
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  return (inTok * p.input + outTok * p.output) / 1e6 + (searches * p.searchPer1000) / 1000;
}

export async function analyzeMatch({ entry, apiKey, model, cfg, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const body = {
    model,
    input: buildPrompt(entry, today),
    tools: [{ type: 'web_search', search_context_size: cfg.searchContextSize }],
    max_output_tokens: cfg.maxOutputTokens,
    text: { format: { type: 'json_schema', name: 'radar_local', strict: true, schema: AI_SCHEMA } },
  };
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning = { effort: 'low' };
  const res = await fetchImpl(URL_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const resp = await res.json();
  const { text, citations, searches, usage } = parseResponse(resp);
  const cost = estimateCost(usage, searches, model, cfg.prices);
  const base = { consultedAt: new Date(now).toISOString(), model, searches, usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 }, costUsd: cost };
  if (citations.size === 0 || !text) {
    return { ...base, status: 'DATOS INSUFICIENTES', injuries: [], suspensions: [], rotation: { level: 'unknown', team: 'none', reason: null, source_url: null }, lineup: { confirmed: false, home: [], away: [], source_url: null }, summary: null, sources: [], droppedClaims: 0 };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('respuesta de IA no es JSON válido');
  }
  const clean = sanitize(raw, citations);
  const usedUrls = new Set(
    [...clean.injuries, ...clean.suspensions].map((c) => normUrl(c.source_url)).concat([normUrl(clean.rotation.source_url), normUrl(clean.lineup.source_url)]),
  );
  const sources = [...citations.entries()].filter(([k]) => usedUrls.has(k)).map(([, v]) => v);
  const hasFindings = clean.injuries.length || clean.suspensions.length || clean.rotation.level !== 'unknown' || clean.lineup.confirmed;
  return { ...base, ...clean, status: hasFindings ? 'OK' : 'SIN HALLAZGOS VERIFICABLES', sources };
}

/** Reglas deterministas: convierten hallazgos verificados en advertencias. Nunca tocan los %. */
export function warningsFromAi(ai, cfg) {
  if (!ai || ai.status === 'DATOS INSUFICIENTES' || ai.status === 'error') return [];
  const out = [];
  const absent = [...ai.injuries, ...ai.suspensions].filter((c) => c.team === 'home' && c.status === 'out');
  if (absent.length >= cfg.warnHomeAbsences) {
    const names = absent.map((c) => c.player).join(', ');
    out.push({
      level: absent.length >= cfg.severeHomeAbsences ? 2 : 1,
      text: `🔴 ADVERTENCIA: ${absent.length} bajas verificadas en el local (${names}). El % del modelo no se modifica (el efecto de bajas no está validado históricamente); se reduce el nivel de confianza.`,
    });
  }
  if (ai.rotation.level === 'high' && ['home', 'both'].includes(ai.rotation.team)) {
    out.push({ level: 1, text: `🔴 ADVERTENCIA: riesgo alto de rotaciones en el local${ai.rotation.reason ? ` (${ai.rotation.reason})` : ''}. Se reduce el nivel de confianza; el % no cambia.` });
  }
  return out;
}
