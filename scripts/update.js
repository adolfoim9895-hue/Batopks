#!/usr/bin/env node
// Uso: node scripts/update.js   (claves por variables de entorno; ver README)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run } from './lib/run.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
try {
  const out = await run({ cfg, outDir: join(root, 'docs', 'data'), cacheDir: join(root, '.cache') });
  console.log(`OK: ${out.counts.total} partidos (alta ${out.counts.alta}, media ${out.counts.media}, datos insuficientes ${out.counts.insuficientes})`);
  for (const s of out.sources) console.log(` - ${s.name}: ${s.status} ${s.detail || ''}`);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
