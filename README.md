# Radar Local — Pronósticos Fútbol

Pronósticos **pre-partido** (minuto 0) de los partidos de los próximos 8 días, calculados con un modelo Poisson validado con resultados históricos. Se actualiza solo con GitHub Actions y se publica en GitHub Pages. Lee `ARQUITECTURA.md` para limitaciones y costos.

**Regla central:** si no hay datos suficientes y verificables, la app muestra «DATOS INSUFICIENTES». Ninguna probabilidad la inventa una IA.

## Servicios externos y dependencias
| Servicio | Para qué | Clave | Costo |
|---|---|---|---|
| football-data.org | calendarios y resultados (fuente principal) | `FOOTBALL_DATA_KEY` (gratis) | US$0 |
| openfootball | respaldo sin clave | — | US$0 |
| API-Football | ligas menores (opcional) | `API_FOOTBALL_KEY` | gratis / pago |
| OpenAI API | bajas, rotaciones, alineaciones con búsqueda web (opcional) | `OPENAI_API_KEY` | ver ARQUITECTURA.md |

Dependencias de código: **ninguna** (Node 20+, `fetch` y `node:test` integrados).

## Actualizar tu repositorio de GitHub (paso a paso)
1. **Respalda** tu repo actual (copia local o rama `respaldo`).
2. Descomprime el ZIP. Copia su contenido a la raíz de tu repo, **reemplazando** la app anterior. La carpeta `docs/` es el sitio; no borres `.github/`. Conserva tu `CNAME` si usas dominio propio (cópialo a `docs/`).
3. Sube los cambios a la rama `main` (`git add -A && git commit -m "Radar Local v2" && git push`).
4. **Claves** — en GitHub: *Settings → Secrets and variables → Actions → New repository secret*:
   - `FOOTBALL_DATA_KEY`: regístrate gratis en football-data.org (te la envían por correo).
   - `API_FOOTBALL_KEY` *(opcional)*: api-football.com → dashboard.
   - `OPENAI_API_KEY` *(opcional)*: platform.openai.com → API keys. Pon un **límite mensual de gasto** en Billing.
   - En la pestaña *Variables* puedes crear `OPENAI_MODEL` (por defecto `gpt-5-mini`).
5. **Pages** — *Settings → Pages → Build and deployment → Source: GitHub Actions* (no «Deploy from a branch»).
6. **Primera ejecución** — pestaña *Actions → «Actualizar y publicar» → Run workflow*. Revisa el log: cada proveedor imprime su estado. Luego abre la URL de Pages en el teléfono.
   - Si football-data devuelve 403 en temporadas anteriores, tu plan no incluye historial: el modelo usará menos datos y quizá no logre validarse (verás «Validación histórica insuficiente»). Es el comportamiento honesto, no un error.
7. A partir de ahí corre solo cada 6 h, y al hacer push a `main`.

## Qué detecta errores antes de publicar
`npm test` corre 24 pruebas (modelo, ausencia de fuga de datos, calibración, reglas de confianza, caché, caídas de proveedores, IA que inventa fuentes, validador de salida, interfaz sin claves). El workflow **no publica si fallan**, y además valida `predictions.json` (1X2 suma 1, sin niveles sin validación, sin «alta» con advertencias, afirmaciones de IA con fuente). Si solo falla la descarga de datos, se publica el último JSON válido (la app avisa si tiene >36 h).

## Uso local
```bash
npm test
FOOTBALL_DATA_KEY=xxx node scripts/update.js     # genera docs/data/*.json
npx serve docs                                    # o: python3 -m http.server -d docs
```

## Personalizar
Todo en `config.json`: ligas (`footballData.competitions`, `apiFootball.leagues`), vida media del peso temporal, umbrales de confianza alta/media, tope de partidos con IA (`ai.maxMatches`), horas de caché de IA. Códigos de competición de football-data: PL, ELC, PD, SA, BL1, FL1, DED, PPL, BSA, CL…

## Estructura
```
docs/                 sitio estático (index.html, app.js, styles.css, data/predictions.json)
scripts/update.js     punto de entrada (Actions)
scripts/lib/          proveedores, modelo, backtest, confianza, IA, validador
tests/                pruebas (ligas simuladas SOLO para testear; no se muestran en la app)
.github/workflows/    update.yml (actualiza y publica), test.yml (PRs)
```

## Aviso
Estimaciones estadísticas, no garantías ni asesoría de apuestas.
