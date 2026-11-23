// Cliente HTTP con caché en disco, límite de ritmo por host, reintentos en 429 y uso de caché
// vencida si el proveedor falla (la app sigue funcionando con datos algo antiguos).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createHttp({ cacheDir, fetchImpl = globalThis.fetch, now = () => Date.now(), sleep, log = () => {} } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const last = new Map();
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  const cachePath = (url) => join(cacheDir, createHash('sha1').update(url).digest('hex') + '.json');
  const readCache = (url) => {
    if (!cacheDir) return null;
    try {
      const p = cachePath(url);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    } catch {
      return null;
    }
  };

  /** @returns {Promise<{body:any, fromCache:boolean, stale:boolean, fetchedAt:number}>} */
  return async function getJson(url, { headers = {}, ttlHours = 6, minIntervalMs = 0, retries = 2 } = {}) {
    const cached = readCache(url);
    if (cached && now() - cached.at < ttlHours * 3600e3) {
      return { body: cached.body, fromCache: true, stale: false, fetchedAt: cached.at };
    }
    const host = new URL(url).host;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const gap = minIntervalMs - (now() - (last.get(host) || 0));
      if (gap > 0) await wait(gap);
      last.set(host, now());
      try {
        const res = await fetchImpl(url, { headers });
        if (res.status === 429) {
          const ra = Number(res.headers?.get?.('retry-after')) || 61;
          log(`429 en ${host}, esperando ${ra}s`);
          lastErr = new Error('HTTP 429');
          await wait(ra * 1000);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (cacheDir) writeFileSync(cachePath(url), JSON.stringify({ at: now(), body }));
        return { body, fromCache: false, stale: false, fetchedAt: now() };
      } catch (e) {
        lastErr = e;
        if (/HTTP 4(0[0-9]|1[0-9]|2[0-8])/.test(String(e.message))) break; // errores de cliente: no reintentar
      }
    }
    if (cached) {
      log(`Usando caché vencida para ${host} (${lastErr?.message})`);
      return { body: cached.body, fromCache: true, stale: true, fetchedAt: cached.at };
    }
    throw lastErr || new Error('fallo de red');
  };
}
