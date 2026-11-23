#!/usr/bin/env node
// Uso: node scripts/validate-output.js docs/data/predictions.json
import { readFileSync } from 'node:fs';
import { validateOutput } from './lib/validateOutput.js';

const file = process.argv[2] || 'docs/data/predictions.json';
let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`No se pudo leer ${file}: ${e.message}`);
  process.exit(1);
}
const errors = validateOutput(data);
if (errors.length) {
  console.error('Validación fallida:\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log(`Validación OK (${data.matches.length} partidos, generado ${data.generatedAt})`);
