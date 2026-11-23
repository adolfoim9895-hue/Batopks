// Orquestador: proveedores -> validación histórica -> pronósticos -> IA opcional -> JSON validado.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHttp } from './http.js';
import { fetchFootballData } from './providers/footballData.js';
import { fetchApiFootball } from './providers/apiFootball.js';
import { fetchOpenFootball } from './providers/openfootball.js';
import { runBacktest } from './backtest.js';
import { analyzeCompetition, applyConfidence } from './pipeline.js';
import { analyzeMatch, warningsFromAi } from './ai.js';
import { validateOutput } from './validateOutput.js';
import { updateHistory } from './history.js';

export async function run({ cfg, env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), outDir, cacheDir, sleep, log = console.log }) {
  const getJson = createHttp({ cacheDir: cacheDir && join(cacheDir, 'http'), fetchImpl, now: () => now, sleep, log });
  const sources = [];

  // 1) Proveedores (cada uno puede fallar sin tumbar al resto)
  const safe = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      log(`Proveedor ${name} falló: ${e.message}`);
      return { info: { name, status: 'error', detail: e.message, fetchedAt: null, url: '' }, competitions: [] };
    }
  };
  const [fd, af] = await Promise.all([
    safe('football-data.org', () => fetchFootballData({ getJson, key: env.FOOTBALL_DATA_KEY, cfg: cfg.footballData, log })),
    safe('API-Football', () => fetchApiFootball({ getJson, key: env.API_FOOTBALL_KEY, cfg: cfg.apiFootball, now, log })),
  ]);
  const have = new Set(fd.competitions.map((c) => c.key));
  // openfootball solo rellena lo que football-data no pudo entregar (o ligas que nadie más cubre)
  const afNames = new Set(af.competitions.map((c) => `${c.country}|${c.name}`));
  const of = await safe('openfootball', () =>
    fetchOpenFootball({ getJson, cfg: cfg.openfootball, now, log, only: (f) => !(f.fd && have.has(f.fd)) && !afNames.has(`${f.country}|${f.name}`) }),
  );
  sources.push(fd.info, af.info, of.info);

  const order = new Map();
  [...cfg.footballData.competitions].forEach((k, i) => order.set(k, i));
  const comps = [...fd.competitions, ...af.competitions, ...of.competitions];
  const infoByProvider = { 'football-data.org': fd.info, 'API-Football': af.info, openfootball: of.info };
  comps.forEach((c) => {
    if (!order.has(c.key)) order.set(c.key, 100 + order.size);
  });

  // 2) Validación histórica
  const validation = runBacktest(comps, cfg, now);
  log(`Backtest: n=${validation.n}, brier=${validation.brier?.toFixed(4)}, baseline=${validation.baselineBrier?.toFixed(4)}, validado=${validation.skillOK}`);

  // 3) Pronósticos
  let matches = [];
  for (const c of comps) {
    matches = matches.concat(analyzeCompetition(c, order.get(c.key), now, cfg, validation, infoByProvider[c.provider]));
  }
  matches.forEach((m) => applyConfidence(m, validation, cfg));

  // 4) IA opcional (solo candidatos; caché por partido y día)
  const aiInfo = { name: 'OpenAI (web search)', url: 'https://platform.openai.com', status: 'sin_clave', detail: 'OPENAI_API_KEY no configurada (opcional)', fetchedAt: null, matchesAnalyzed: 0, costUsd: 0 };
  if (env.OPENAI_API_KEY && cfg.ai.enabled) {
    const model = env.OPENAI_MODEL || cfg.ai.defaultModel;
    const cand = matches
      .filter((m) => m.dataStatus === 'OK' && m.status !== 'FINISHED' && Date.parse(m.kickoff) > now && (m.confidence.tier || m.probs.home >= cfg.ai.minHomeProb))
      .sort((a, b) => b.probs.home - a.probs.home)
      .slice(0, cfg.ai.maxMatches);
    let fails = 0;
    for (const m of cand) {
      const day = new Date(now).toISOString().slice(0, 10);
      const cp = cacheDir && join(cacheDir, 'ai', `${m.id.replace(/[^a-z0-9]/gi, '_')}-${day}.json`);
      let ai = null;
      try {
        if (cp && existsSync(cp)) {
          const c = JSON.parse(readFileSync(cp, 'utf8'));
          if (now - Date.parse(c.consultedAt) < cfg.ai.cacheHours * 3600e3) ai = { ...c, cached: true };
        }
        if (!ai) {
          ai = await analyzeMatch({ entry: m, apiKey: env.OPENAI_API_KEY, model, cfg: cfg.ai, fetchImpl, now });
          if (cp) {
            mkdirSync(join(cacheDir, 'ai'), { recursive: true });
            writeFileSync(cp, JSON.stringify(ai));
          }
          aiInfo.costUsd += ai.costUsd || 0;
        }
        aiInfo.matchesAnalyzed++;
      } catch (e) {
        log(`IA falló en ${m.id}: ${e.message}`);
        ai = { status: 'error', detail: e.message, consultedAt: new Date(now).toISOString(), injuries: [], suspensions: [], sources: [] };
        if (++fails >= 3) {
          m.ai = ai;
          log('Demasiados fallos de IA: se detiene la capa de IA en esta ejecución');
          break;
        }
      }
      m.ai = ai;
      m.warnings = m.warnings.filter((w) => !w.ai).concat(warningsFromAi(ai, cfg.ai).map((w) => ({ ...w, ai: true })));
      m.explain = m.explain.filter((l) => !l.startsWith('IA:'));
      if (ai.status === 'OK') {
        const n = ai.injuries.length + ai.suspensions.length;
        m.explain.push(`IA: ${n} baja(s)/sanción(es) verificada(s) con fuente; rotaciones: ${ai.rotation.level}; alineación confirmada: ${ai.lineup.confirmed ? 'sí' : 'no'}. Consultado ${ai.consultedAt.slice(0, 10)}.`);
      } else {
        m.explain.push(`IA: ${ai.status === 'error' ? 'no disponible' : ai.status} — bajas, rotaciones y alineaciones: DATOS INSUFICIENTES.`);
      }
      applyConfidence(m, validation, cfg);
    }
    aiInfo.status = aiInfo.matchesAnalyzed ? (fails ? 'parcial' : 'ok') : fails ? 'error' : 'ok';
    aiInfo.detail = `${aiInfo.matchesAnalyzed} partidos analizados con ${model}; costo estimado ≈ US$${aiInfo.costUsd.toFixed(3)}`;
    aiInfo.fetchedAt = now;
  }
  sources.push(aiInfo);

  matches.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.competition.order - b.competition.order);
  const out = {
    schema: 2,
    generatedAt: new Date(now).toISOString(),
    window: { from: new Date(now).toISOString().slice(0, 10), days: cfg.windowDays },
    sources: sources.map((s) => ({ ...s, fetchedAt: s.fetchedAt ? new Date(s.fetchedAt).toISOString() : null })),
    validation: { n: validation.n, brier: validation.brier, baselineBrier: validation.baselineBrier, skillOK: validation.skillOK, buckets: validation.buckets, generatedAt: validation.generatedAt },
    counts: {
      total: matches.length,
      alta: matches.filter((m) => m.confidence.tier === 'alta').length,
      media: matches.filter((m) => m.confidence.tier === 'media').length,
      insuficientes: matches.filter((m) => m.dataStatus !== 'OK').length,
    },
    matches,
  };
  const errors = validateOutput(out);
  if (errors.length) throw new Error('Salida inválida, no se publica:\n- ' + errors.slice(0, 20).join('\n- '));
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'predictions.json'), JSON.stringify(out));
    writeFileSync(join(outDir, 'validation.json'), JSON.stringify(validation, null, 1));
    // Historial: solo pronósticos vistos antes del partido + resultado real cuando termina
    const results = new Map();
    for (const c of comps) for (const m of c.matches) if (m.usable && m.gh != null) results.set(m.id, { home: m.gh, away: m.ga });
    try {
      const sm = updateHistory({ dir: join(outDir, 'history'), matches, results, now, cfg });
      log(`Historial: ${sm.totals.n} evaluados, ${sm.pending} pendientes`);
    } catch (e) {
      log(`Historial no actualizado: ${e.message}`); // no debe tumbar la publicación
    }
  }
  return out;
}
