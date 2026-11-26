# Pronósticos Fútbol — modo manual (sin API)

Claude analiza los partidos que le mandas en captura; la app los muestra, los guarda, mide aciertos y genera un Excel.

## Flujo
1. **Antes del partido:** mándale a Claude las capturas (con la cuota del local). Te devuelve `lote-AAAAMMDD-HHMM.json`.
2. En GitHub: carpeta `docs/data/lotes/` → *Add file → Upload files* → sube ese archivo → *Commit*. El workflow «Actualizar y publicar» corre solo (~1 min).
3. **Después del partido:** en la app, abajo, toca **«Archivo para Claude (pendientes + guía)»** y mándaselo a Claude (en el mismo chat o en uno nuevo). Te devuelve otro `lote-….json` con los resultados y los minutos de gol. Súbelo igual a `docs/data/lotes/`.
4. El Excel se baja desde la app (**«Descargar Excel»**): fecha, torneo, equipos, cuota del local, porcentajes, marcador final, minutos de los goles y acierto.

## Reglas de honestidad
- Cuotas de casas de apuestas: **solo se registran**; no se usan para calcular nada.
- Cada dato (partidos recientes, h2h, bajas) debe citar una fuente consultada; lo que no la tenga se descarta.
- Menos de 3 partidos recientes verificados por equipo → «DATOS INSUFICIENTES», sin porcentajes.
- Un análisis hecho después del inicio del partido se descarta; un resultado solo vale si el lote se creó después del inicio.
- Los porcentajes son estimaciones de Claude, **no un modelo validado**. El «Récord real de aciertos» es lo que mide si funcionan.

## Archivos
```
docs/                    sitio (index.html, app.js, xlsx.js, styles.css, sw.js)
docs/data/lotes/         AQUÍ subes los lotes (.json)
docs/data/guia-claude.json   instrucciones y formato para Claude
scripts/build-data.js    valida los lotes y genera docs/data/partidos/ y resumen.json (lo hace el workflow)
tests/manual.test.js     pruebas (npm test)
```
Los archivos del modo anterior (football-data, Poisson, config.json…) ya no se usan; puedes dejarlos o borrarlos. La clave `FOOTBALL_DATA_KEY` ya no hace falta.
