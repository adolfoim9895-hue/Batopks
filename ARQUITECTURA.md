# Análisis de viabilidad, límites, costos y alternativas

## Veredicto
**Viable**, con tres recortes honestos respecto a la especificación (abajo). La arquitectura elegida no necesita servidor: **GitHub Actions** calcula todo cada 6 h y publica un JSON estático en **GitHub Pages**. Las claves viven solo en *GitHub Secrets*; el JavaScript público nunca las ve.

```
Proveedores de datos ──► caché (actions/cache) ──► modelo Poisson ──► backtest ──► niveles de confianza
 football-data.org         respuestas HTTP          ataque/defensa      walk-forward   (solo si hay validación)
 API-Football (opc.)       + resultados de IA        por rival
 openfootball (respaldo)                                    │
                          IA opcional (OpenAI + web search) ─┘  solo bajas/rotaciones/alineaciones, con cita
                                                            ▼
                                   docs/data/predictions.json ─► validador ─► GitHub Pages (HTML/CSS/JS)
```

## Qué sí hace
- Descarga calendarios y resultados (temporada actual + 2 anteriores) y los normaliza.
- Ajusta un Poisson con fuerza de ataque/defensa **ajustada por rival**, peso decreciente con el tiempo y contracción (evita extremos con pocos partidos). Calcula 1X2, marcadores, xG, más de 0.5/1.5/2.5 y ambos anotan.
- **Valida históricamente (walk-forward)**: para cada semana pasada ajusta solo con datos anteriores y predice la siguiente. Mide Brier/log-loss contra una referencia ingenua y la calibración de P(local) por tramos. Si el modelo no supera la referencia o la muestra es chica, **no hay niveles de confianza**.
- Confianza alta/media = el tramo de probabilidad tiene frecuencia histórica real suficiente (n mínimo, tasa mínima, brecha de calibración máxima; ver `config.json`). Una advertencia 🔴 baja de alta a media; una advertencia grave quita el nivel.
- La IA (opcional) solo investiga bajas, sanciones, rotaciones y alineaciones. Cada hecho debe citar una URL que aparezca en las citas reales de la búsqueda; si no, se descarta. Sin citas → «DATOS INSUFICIENTES». **La IA nunca cambia un porcentaje**: solo dispara advertencias por reglas.
- Sin ninguna clave la app sigue funcionando con openfootball; si un proveedor cae se usa caché vencida o se omite esa liga.

## Limitaciones (importantes)
1. **Transfermarkt no está integrado.** Sus condiciones de uso prohíben el scraping y no tiene API gratuita. El campo aparece como «DATOS INSUFICIENTES». Alternativa: API de pago de terceros.
2. **Cobertura limitada por el plan gratuito.** football-data.org gratis cubre unas 10–12 competiciones (PL, Championship, LaLiga, Serie A, Bundesliga, Ligue 1, Eredivisie, Primeira Liga, Brasileirão, Champions…). Sub-19, ligas menores, Argentina, MLS, etc. requieren API-Football (gratis ≈100 peticiones/día; **verifica en tu cuenta qué temporadas permite el plan gratuito**) o un plan de pago. Lo que no esté cubierto simplemente no aparece: no se inventa.
3. **H2H, bajas y rotaciones no ajustan el %**: no se validaron históricamente, así que solo informan o degradan el nivel de confianza. Es una decisión deliberada para no meter ajustes arbitrarios.
4. **Un modelo de goles no ve todo**: motivación, clima, árbitro, etc. Las probabilidades son estimaciones, no garantías.
5. **No pude probar con las APIs reales** durante el desarrollo (mi entorno bloquea esos dominios). Todo se probó con 24 pruebas automáticas y ligas simuladas; el primer despliegue real conviene vigilarlo (README, paso 6).

## Costos
| Servicio | Costo |
|---|---|
| GitHub Pages + Actions (repo público) | US$0 |
| football-data.org (plan gratuito, 10 req/min) | US$0 |
| openfootball | US$0 |
| API-Football | US$0 (gratis) o de pago si necesitas más ligas/temporadas |
| OpenAI API | solo si activas la IA (abajo) |

**IA — precios usados** (página oficial de precios de OpenAI, consultada el 2026-11-22): gpt-5-mini US$0.25 / 1M tokens de entrada y US$2.00 / 1M de salida; búsqueda web US$10 por 1,000 llamadas (los tokens del contenido buscado se cobran a tarifa del modelo). gpt-5-nano: US$0.05 / US$0.40.

**Supuestos por partido analizado una vez al día:** escenario bajo = 1 búsqueda, 5k tokens de entrada, 1k de salida (≈US$0.013); escenario alto = 2 búsquedas, 8k de entrada, 1.5k de salida (≈US$0.025). Los tokens de razonamiento cuentan como salida; si el modelo razona mucho el costo sube.

| Partidos/día con IA | Por día | Por mes (30 d) |
|---|---|---|
| 10 | US$0.13 – 0.25 | US$4 – 7.5 |
| 50 | US$0.67 – 1.25 | US$20 – 37.5 |
| 100 | US$1.33 – 2.50 | US$40 – 75 |

Notas: (a) el workflow corre cada 6 h y la caché de IA dura 12 h, así que un partido puede analizarse **2 veces al día** (duplica la tabla) — sube `ai.cacheHours` a 24 para analizarlo 1 vez; (b) por defecto solo se analizan los **30 mejores candidatos** (`ai.maxMatches`), así que 100/día exige subir ese tope; (c) la app muestra el costo estimado real de cada ejecución en «Fuentes y validación del modelo»; (d) **tu suscripción de ChatGPT no incluye la API**: se factura aparte en platform.openai.com; pon un límite de gasto mensual allí.

## Alternativas consideradas
- *Backend propio (Cloud Run, Workers)*: más flexible, pero cuesta mantenimiento y dinero; Actions + Pages es gratis.
- *Scraping de sitios de estadísticas/apuestas*: descartado por términos de uso, CAPTCHA y fragilidad.
- *Solo IA para estimar probabilidades*: descartado; es justo lo que pediste evitar.
- *Dixon-Coles completo / Elo*: posible mejora futura; el backtest incluido permite comparar sin adivinar.
