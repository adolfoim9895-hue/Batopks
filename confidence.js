// Niveles de confianza. Solo existen si hay validación histórica suficiente: el % mostrado como
// "histórico validado" es la frecuencia REAL de victorias locales en el backtest para ese tramo.

export function findBucket(validation, pHome) {
  if (!validation || !Array.isArray(validation.buckets)) return null;
  return validation.buckets.find((b) => pHome >= b.lo && pHome < (b.hi >= 1 ? 1.0000001 : b.hi)) || null;
}

function bucketPasses(bucket, rule) {
  if (!bucket || bucket.n < rule.minBucketN || bucket.actual == null) return false;
  if (bucket.actual < rule.minHitRate) return false;
  return Math.abs(bucket.actual - bucket.avgPred) <= rule.maxCalibrationGap;
}

/**
 * @returns {{tier:'alta'|'media'|null, reason:string, bucket:object|null}}
 * warnings: [{level:1|2,text}]. Nivel 1 impide "alta"; nivel 2 impide cualquier nivel.
 */
export function classify({ probs, dataOk, warnings = [] }, validation, cfg) {
  const bucket = findBucket(validation, probs?.home ?? 0);
  if (!dataOk) return { tier: null, reason: 'DATOS INSUFICIENTES', bucket: null };
  if (!validation || !validation.skillOK) {
    return { tier: null, reason: 'Sin validación histórica suficiente: no se asigna nivel de confianza', bucket };
  }
  const isFavorite = probs.home > probs.draw && probs.home > probs.away;
  if (!isFavorite) return { tier: null, reason: 'El local no es el resultado más probable', bucket };
  const maxLevel = warnings.reduce((m, w) => Math.max(m, w.level || 1), 0);
  if (maxLevel >= 2) return { tier: null, reason: 'Riesgos graves detectados (🔴 ADVERTENCIA)', bucket };
  const { alta, media } = cfg.confidence;
  if (probs.home >= alta.minHomeProb && bucketPasses(bucket, alta)) {
    if (maxLevel >= 1) {
      return bucketPasses(bucket, media)
        ? { tier: 'media', reason: 'Cumple criterios de alta pero hay advertencias: baja a media', bucket }
        : { tier: null, reason: 'Advertencias y tramo sin validación suficiente', bucket };
    }
    return { tier: 'alta', reason: 'Tramo validado históricamente y sin advertencias', bucket };
  }
  if (probs.home >= media.minHomeProb && bucketPasses(bucket, media)) {
    return { tier: 'media', reason: 'Tramo con validación histórica aceptable', bucket };
  }
  return { tier: null, reason: 'No cumple los umbrales validados', bucket };
}
