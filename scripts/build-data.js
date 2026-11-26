// Uso: node scripts/build-data.js [carpeta_lotes] [carpeta_salida]
// Lee docs/data/lotes/*.json (subidos a mano), valida y genera docs/data/partidos/AAAA-MM.json + docs/data/resumen.json
import { readLotes, buildFromLotes, writeOutput } from './lib/lotes.js';

const lotesDir = process.argv[2] || 'docs/data/lotes';
const outDir = process.argv[3] || 'docs/data';
const { lotes, problems: readProblems } = readLotes(lotesDir);
const built = buildFromLotes(lotes, Date.now());
built.summary.problems = [...readProblems, ...built.summary.problems].slice(0, 40);
writeOutput(outDir, built);
const c = built.summary.counts;
console.log(`Lotes leídos: ${lotes.length} · partidos: ${c.total} · evaluados: ${c.evaluated} · sin resultado: ${c.open} · datos insuficientes: ${c.insufficient}`);
for (const p of built.summary.problems) console.log('AVISO:', p);
