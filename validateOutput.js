// Validador del JSON publicado. Si algo no cumple, el workflow NO publica.
export function validateOutput(data) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!data || typeof data !== 'object') return ['la salida no es un objeto'];
  if (data.schema !== 2) err('schema debe ser 2');
  if (!data.generatedAt || Number.isNaN(Date.parse(data.generatedAt))) err('generatedAt inválido');
  if (!Array.isArray(data.matches)) err('matches debe ser un arreglo');
  if (!Array.isArray(data.sources)) err('sources debe ser un arreglo');
  if (errors.length) return errors;
  const ids = new Set();
  for (const m of data.matches) {
    const tag = `partido ${m.id}`;
    if (!m.id || ids.has(m.id)) err(`${tag}: id vacío o duplicado`);
    ids.add(m.id);
    if (Number.isNaN(Date.parse(m.kickoff))) err(`${tag}: kickoff inválido`);
    if (!m.home?.name || !m.away?.name) err(`${tag}: faltan nombres de equipos`);
    if (!['OK', 'DATOS INSUFICIENTES'].includes(m.dataStatus)) err(`${tag}: dataStatus inválido`);
    if (m.dataStatus === 'DATOS INSUFICIENTES') {
      if (m.probs || m.confidence?.tier) err(`${tag}: con DATOS INSUFICIENTES no puede haber probabilidades ni nivel`);
      continue;
    }
    const p = m.probs;
    if (!p) {
      err(`${tag}: faltan probabilidades`);
      continue;
    }
    const s = p.home + p.draw + p.away;
    if (![p.home, p.draw, p.away].every((x) => x >= 0 && x <= 1) || Math.abs(s - 1) > 0.002) err(`${tag}: 1X2 no suma 1 (${s})`);
    if (!(m.xg && m.xg.home > 0 && m.xg.away > 0)) err(`${tag}: xG inválido`);
    const g = m.goals || {};
    if (!(g.over05 >= g.over15 && g.over15 >= g.over25)) err(`${tag}: over 0.5/1.5/2.5 no es monótono`);
    if (!(g.btts >= 0 && g.btts <= 1)) err(`${tag}: BTTS fuera de rango`);
    if (!Array.isArray(m.scores) || m.scores.length === 0) err(`${tag}: sin marcadores`);
    if (m.confidence?.tier && !['alta', 'media'].includes(m.confidence.tier)) err(`${tag}: tier inválido`);
    if (m.confidence?.tier) {
      const b = m.confidence.bucket;
      if (!b || !(b.n > 0)) err(`${tag}: nivel de confianza sin validación histórica`);
    }
    if (m.confidence?.tier === 'alta' && (m.warnings || []).some((w) => w.level >= 1)) err(`${tag}: "alta" con advertencias`);
    if (!Array.isArray(m.sources) || m.sources.length === 0) err(`${tag}: sin fuentes`);
    if (m.ai && m.ai.status === 'OK') {
      const urls = new Set((m.ai.sources || []).map((x) => x.url));
      for (const c of [...(m.ai.injuries || []), ...(m.ai.suspensions || [])]) {
        if (!urls.has(c.source_url) && !(m.ai.sources || []).some((x) => x.url.replace(/[?#].*$/, '') === String(c.source_url).replace(/[?#].*$/, ''))) {
          err(`${tag}: afirmación de IA sin fuente registrada (${c.player})`);
        }
      }
    }
  }
  return errors;
}
