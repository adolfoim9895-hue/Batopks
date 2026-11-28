'use strict';
(function () {
  var state = { res: null, months: {}, dayKey: null, filter: 'all', query: '', favs: loadFavs(), open: {}, loaded: false, error: null };
  var tz = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return undefined; } })();
  var $ = function (id) { return document.getElementById(id); };
  var WAIT_MS = 2 * 36e5; // pasadas 2 h del inicio se espera el resultado

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem('rl_favs') || '{"m":[]}'); } catch (e) { return { m: [] }; }
  }
  function saveFavs() { try { localStorage.setItem('rl_favs', JSON.stringify(state.favs)); } catch (e) { /* sin almacenamiento */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }

  // ---------- fechas (zona horaria del dispositivo) ----------
  function dayKeyOf(d) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  function addDays(key, n) {
    var p = key.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }
  function labelFor(key) {
    var today = dayKeyOf(new Date());
    var rel = key === today ? 'Hoy' : key === addDays(today, 1) ? 'Mañana' : key === addDays(today, -1) ? 'Ayer' : '';
    var p = key.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    var txt = new Intl.DateTimeFormat('es', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' }).format(d).replace(/\./g, '');
    return { rel: rel || txt.split(' ')[0].replace(',', ''), txt: txt };
  }
  function timeOf(iso) { return new Intl.DateTimeFormat('es', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }

  // porcentajes enteros que suman 100
  function pcts(p) {
    var v = [p.home, p.draw, p.away].map(function (x) { return x * 100; });
    var f = v.map(Math.floor);
    var rest = 100 - f.reduce(function (a, b) { return a + b; }, 0);
    v.map(function (x, i) { return [x - f[i], i]; }).sort(function (a, b) { return b[0] - a[0]; }).slice(0, rest).forEach(function (r) { f[r[1]]++; });
    return f;
  }

  // ---------- datos: resumen.json + un archivo por mes ----------
  function getJson(url, force) {
    return fetch(url + (force ? '?t=' + Date.now() : ''), { cache: force ? 'reload' : 'default' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function monthsFor(key) {
    var a = [key.slice(0, 7), addDays(key, -1).slice(0, 7), addDays(key, 1).slice(0, 7)];
    return a.filter(function (m, i) { return a.indexOf(m) === i; });
  }
  function ensureMonths(list, force) {
    var known = state.res && state.res.months ? state.res.months : [];
    var need = list.filter(function (mk) { return known.indexOf(mk) >= 0 && !(mk in state.months); });
    if (!need.length) return Promise.resolve();
    need.forEach(function (mk) { state.months[mk] = null; });
    return Promise.all(need.map(function (mk) { return getJson('data/partidos/' + mk + '.json', force); }))
      .then(function (res) { need.forEach(function (mk, i) { state.months[mk] = res[i]; }); });
  }
  function load(force) {
    var btn = $('btnRefresh');
    btn.classList.add('spin');
    if (force) state.months = {};
    return getJson('data/resumen.json', force).then(function (r) {
      state.res = r; state.loaded = true;
      if (!state.dayKey) state.dayKey = dayKeyOf(new Date());
      return ensureMonths(monthsFor(state.dayKey), force);
    }).then(function () { render(); renderRecord(); })
      .then(function () { setTimeout(function () { btn.classList.remove('spin'); }, 300); });
  }
  function allMatches() {
    var out = [];
    Object.keys(state.months).forEach(function (mk) { var m = state.months[mk]; if (m && m.matches) out = out.concat(m.matches); });
    return out;
  }
  function loadAll() { return ensureMonths(state.res && state.res.months ? state.res.months : []); }
  function matchesOfDay(key) {
    return allMatches().filter(function (m) { return dayKeyOf(new Date(m.kickoff)) === key; });
  }
  function htText(m) { var t = m.result && m.result.ht; return t ? ' · Medio tiempo ' + t.home + '-' + t.away : ''; }
  function isWaiting(m) { return !m.result && Date.now() > Date.parse(m.kickoff) + WAIT_MS; }

  function isFav(m) { return state.favs.m.indexOf(m.id) >= 0; }
  function passes(m) {
    var f = state.filter;
    if (f === 'fav' && !isFav(m)) return false;
    if (f === 'pend' && !isWaiting(m)) return false;
    if (f === 'hit' && m.hit !== true) return false;
    if (f === 'miss' && m.hit !== false) return false;
    var q = state.query.trim().toLowerCase();
    if (q && (m.home + ' ' + m.away + ' ' + m.competition + ' ' + (m.country || '')).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }

  // ---------- render ----------
  function ini(name) { return esc((name || '?').replace(/[^A-Za-zÀ-ÿ0-9 ]/g, '').split(' ').slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase()); }
  function badges(list) {
    if (!list || !list.length) return '<span class="muted">—</span>';
    return '<span class="form">' + list.slice().reverse().map(function (x) { return '<i class="' + x.res + '">' + ({ W: 'V', D: 'E', L: 'D' })[x.res] + '</i>'; }).join('') + '</span>';
  }
  function goalsText(m) {
    var r = m.result;
    if (!r || !r.goals.length) return '';
    return r.goals.map(function (g) {
      return esc(g.minute) + "' " + esc(g.team === 'home' ? m.home : m.away) + (g.type === 'pen' ? ' (p)' : g.type === 'og' ? ' (e.p.c.)' : '');
    }).join(' · ');
  }

  function cardHtml(m) {
    var open = !!state.open[m.id];
    var fav = isFav(m);
    var ok = m.status === 'OK';
    var h = '<article class="card' + (open ? ' open' : '') + '" data-id="' + esc(m.id) + '">';
    h += '<div class="row" data-toggle="' + esc(m.id) + '">';
    h += '<div class="time">' + timeOf(m.kickoff) + '</div>';
    h += '<div class="teams">';
    h += '<div class="team"><span class="crest ph">' + ini(m.home) + '</span><span class="n">' + esc(m.home) + '</span>' + (m.result ? '<span class="score">' + m.result.home + '</span>' : '') + '</div>';
    h += '<div class="team"><span class="crest ph">' + ini(m.away) + '</span><span class="n">' + esc(m.away) + '</span>' + (m.result ? '<span class="score">' + m.result.away + '</span>' : '') + '</div>';
    h += '</div>';
    h += '<button class="cardStar' + (fav ? ' on' : '') + '" data-favm="' + esc(m.id) + '" aria-label="Favorito">' + (fav ? '★' : '☆') + '</button>';
    h += '</div>';

    if (!ok) {
      h += '<div class="noData">DATOS INSUFICIENTES<small>' + esc(m.reason || '') + '</small></div>';
    } else {
      var p = pcts(m.probs);
      h += '<div class="bar" role="img" aria-label="Local ' + p[0] + '%, empate ' + p[1] + '%, visita ' + p[2] + '%"><i class="h" style="width:' + p[0] + '%"></i><i class="d" style="width:' + p[1] + '%"></i><i class="a" style="width:' + p[2] + '%"></i></div>';
      h += '<div class="legend"><span>Local <b>' + p[0] + '%</b></span><span>Empate <b>' + p[1] + '%</b></span><span>Visita <b>' + p[2] + '%</b></span></div>';
      var favName = m.favorite === 'home' ? m.home : m.favorite === 'away' ? m.away : null;
      var favP = m.favorite === 'home' ? p[0] : m.favorite === 'away' ? p[2] : p[1];
      h += '<div class="pick"><div class="t">' + (favName ? 'Gana ' + esc(favName) + ' · ' + favP + '%' : 'Empate · ' + favP + '%') + (m.scores.length ? '<em>Marcador probable ' + esc(m.scores[0].score) + '</em>' : '') + '</div>';
      h += '<span class="pills">' + (m.homeOdds ? '<span class="pill odds">Cuota local ' + m.homeOdds.toFixed(2) + '</span>' : '') + (m.origin && m.origin !== 'claude' ? '<span class="pill est unv">Estimación de ' + (m.origin === 'claude-parcial' ? 'Claude · fuentes parciales' : esc(m.origin === 'chatgpt' ? 'ChatGPT · sin fuentes verificadas' : m.origin)) + '</span>' : '<span class="pill est">Estimación de Claude</span>') + '</span>';
      h += '</div>';
    }
    if (m.result) {
      if (m.hit !== null) h += '<div class="resLine ' + (m.hit ? 'ok' : 'bad') + '">' + (m.hit ? '✅ Acertó' : '❌ Falló') + ' · Final ' + m.result.home + '-' + m.result.away + htText(m) + (m.scoreHit === 'top' ? ' · marcador exacto' : '') + '</div>';
      else h += '<div class="resLine ok" style="background:rgba(154,163,209,.14);color:var(--muted)">Final ' + m.result.home + '-' + m.result.away + htText(m) + '</div>';
      var gt = goalsText(m);
      if (gt) h += '<div class="goalsLine">⚽ ' + gt + '</div>';
      else if (m.result.home + m.result.away > 0) h += '<div class="goalsLine">⚽ Minutos de gol: sin datos verificados.</div>';
    } else if (isWaiting(m)) {
      h += '<div class="waitLine">Esperando resultado — descarga «Archivo para Claude» y pídele los resultados.</div>';
    }
    var w = (m.warnings || [])[0];
    if (w) h += '<div class="warnLine">' + esc(w) + '</div>';
    if (open) h += detailHtml(m);
    return h + '</article>';
  }

  function srcLink(u, label) {
    var s = safeUrl(u);
    return s ? ' <a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(label || 'fuente') + '</a>' : '';
  }
  function detailHtml(m) {
    var h = '<div class="detail">';
    if (m.status === 'OK') {
      if (m.scores.length) h += '<h3>Marcadores más probables</h3><div class="scores">' + m.scores.map(function (s) { return '<span>' + esc(s.score) + (s.p == null ? '' : '<small>' + Math.round(s.p * 100) + '%</small>') + '</span>'; }).join('') + '</div>';
      if ((m.reasoning || []).length) h += '<h3>Por qué</h3><ul>' + m.reasoning.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
      h += '<h3>Forma reciente</h3>';
      h += '<div>' + esc(m.home) + ' ' + badges(m.recent.home) + '</div>';
      h += '<ul class="evi">' + m.recent.home.map(function (x) { return '<li>' + (x.date ? esc(x.date) + ' · ' : '') + (x.venue === 'H' ? 'local ' : x.venue === 'A' ? 'visita ' : '') + 'vs ' + esc(x.opponent) + ' ' + esc(x.score) + srcLink(x.source_url) + '</li>'; }).join('') + '</ul>';
      h += '<div style="margin-top:6px">' + esc(m.away) + ' ' + badges(m.recent.away) + '</div>';
      h += '<ul class="evi">' + m.recent.away.map(function (x) { return '<li>' + (x.date ? esc(x.date) + ' · ' : '') + (x.venue === 'H' ? 'local ' : x.venue === 'A' ? 'visita ' : '') + 'vs ' + esc(x.opponent) + ' ' + esc(x.score) + srcLink(x.source_url) + '</li>'; }).join('') + '</ul>';
    }
    if ((m.warnings || []).length > 1) h += '<h3>Advertencias</h3>' + m.warnings.slice(1).map(function (w) { return '<div class="warnLine">' + esc(w) + '</div>'; }).join('');
    var abs = (m.injuries || []).concat(m.suspensions || []);
    h += '<h3>Bajas y sanciones</h3>';
    h += abs.length ? '<ul>' + abs.map(function (c) { return '<li>' + esc(c.team === 'home' ? m.home : m.away) + ': ' + esc(c.player) + ' — ' + (c.status === 'out' ? 'baja' : 'duda') + (c.detail ? ' (' + esc(c.detail) + ')' : '') + (c.source_date ? ' · ' + esc(c.source_date) : '') + srcLink(c.source_url) + '</li>'; }).join('') + '</ul>' : '<div class="muted">Sin bajas verificadas.</div>';
    if ((m.h2h || []).length) h += '<h3>Enfrentamientos directos</h3><ul>' + m.h2h.map(function (x) { return '<li>' + (x.date ? esc(x.date) + ' · ' : '') + esc(x.home) + ' ' + esc(x.score) + ' ' + esc(x.away) + srcLink(x.source_url) + '</li>'; }).join('') + '</ul>';
    if ((m.sources || []).length) {
      h += '<h3>Fuentes consultadas</h3><ul class="src">' + m.sources.map(function (s) {
        var u = safeUrl(s.url);
        return '<li>' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + '</a>' : esc(s.title)) + (s.date ? ' · ' + esc(s.date) : '') + '</li>';
      }).join('') + '</ul>';
    }
    h += '<div class="muted" style="margin-top:10px">Analizado: ' + esc(new Date(m.analyzedAt).toLocaleString('es', { timeZone: tz })) + ' (antes del partido).</div>';
    return h + '</div>';
  }

  function render() {
    if (!state.loaded) return;
    var key = state.dayKey;
    var lb = labelFor(key);
    $('dayRel').textContent = lb.rel;
    $('dayDate').textContent = lb.txt;

    var msgs = [];
    var res = state.res;
    if (!res) msgs.push('Aún no hay partidos. Mándale capturas a Claude, sube el archivo que te devuelva a docs/data/lotes/ y espera a que termine «Actualizar y publicar».');
    else {
      var late = (res.open || []).filter(function (o) { return Date.now() > Date.parse(o.kickoff) + WAIT_MS; }).length;
      if (late) msgs.push(late + ' partido(s) ya jugado(s) sin resultado. Descarga «Archivo para Claude» (abajo) y pídele los resultados.');
      if ((res.problems || []).length) msgs.push('⚠ ' + res.problems.length + ' aviso(s) al procesar los archivos subidos: ' + res.problems[0]);
    }
    var banner = $('banner');
    banner.hidden = !msgs.length;
    banner.className = 'banner';
    banner.textContent = msgs.join(' ');

    var ms = matchesOfDay(key).filter(passes);
    var by = {};
    ms.forEach(function (m) { (by[m.competition] = by[m.competition] || []).push(m); });
    var h = '';
    Object.keys(by).sort().forEach(function (c) {
      var list = by[c].sort(function (a, b) { return Date.parse(a.kickoff) - Date.parse(b.kickoff); });
      h += '<section class="league"><div class="leagueHead"><h2>' + esc(c) + (list[0].country ? '<small>' + esc(list[0].country) + '</small>' : '') + '</h2></div>';
      list.forEach(function (m) { h += cardHtml(m); });
      h += '</section>';
    });
    if (!h) {
      var total = matchesOfDay(key).length;
      h = '<div class="empty">' + (total ? '<b>Ningún partido coincide con el filtro.</b><br>Hay ' + total + ' partido(s) este día.' : '<b>No hay partidos analizados para este día.</b><br>Aquí aparecen los partidos que le mandas a Claude.') + '</div>';
    }
    $('list').innerHTML = h;
    var c = res && res.counts;
    $('footMeta').textContent = res ? 'Datos generados: ' + new Date(res.generatedAt).toLocaleString('es', { timeZone: tz }) + ' · ' + c.total + ' partidos guardados (' + c.evaluated + ' evaluados, ' + c.open + ' sin resultado)' : '';
  }

  function renderRecord() {
    var box = $('recordBox');
    var t = state.res && state.res.totals;
    if (!t || !t.n) {
      box.innerHTML = '<b>Récord real de aciertos</b><br><span class="muted">Aún no hay partidos evaluados. Se llena solo: cada pronóstico se guarda antes del partido y se compara con el resultado final.</span>';
      return;
    }
    function line(label, x) {
      if (!x || !x.n) return '';
      return '<div>' + label + ': <b>' + x.hits + '/' + x.n + ' (' + Math.round(100 * x.hits / x.n) + '%)</b>' + (x.sumPred ? ' <span class="muted">· esperado ' + Math.round(100 * x.sumPred / x.n) + '%</span>' : '') + '</div>';
    }
    box.innerHTML = '<b>Récord real de aciertos</b> <span class="muted">(pronósticos guardados antes del partido)</span>' +
      '<div>Total: <b>' + t.hits + '/' + t.n + ' (' + Math.round(100 * t.hits / t.n) + '%)</b> <span class="muted">· esperado ' + Math.round(100 * t.sumPred / t.n) + '%</span></div>' +
      line('Cuando Claude favorece al local', t.byPick.home) + line('Cuando favorece empate', t.byPick.draw) + line('Cuando favorece a la visita', t.byPick.away) +
      Object.keys(t.byBucket).map(function (k) { return line('Favorito con ' + k, t.byBucket[k]); }).join('') +
      (t.byOrigin && Object.keys(t.byOrigin).length > 1 ? '<div style="margin-top:6px"><b>Por origen del análisis</b></div>' + Object.keys(t.byOrigin).map(function (k) { return line(k === 'claude' ? 'Claude (con fuentes)' : k === 'chatgpt' ? 'ChatGPT (sin fuentes)' : k === 'claude-parcial' ? 'Claude (fuentes parciales)' : k, t.byOrigin[k]); }).join('') : '') +
      (t.scoreTop1.n ? '<div>Marcador exacto (el más probable): <b>' + t.scoreTop1.hits + '/' + t.scoreTop1.n + '</b></div>' : '');
  }

  function renderWeek() {
    var today = dayKeyOf(new Date());
    var h = '';
    loadAll().then(function () {
      var all = allMatches();
      for (var i = -7; i <= 7; i++) {
        var k = addDays(today, i);
        var ms = all.filter(function (m) { return dayKeyOf(new Date(m.kickoff)) === k; });
        if (!ms.length && i !== 0) continue;
        var hits = ms.filter(function (m) { return m.hit === true; }).length, miss = ms.filter(function (m) { return m.hit === false; }).length;
        var l = labelFor(k);
        h += '<button class="wrow' + (k === state.dayKey ? ' cur' : '') + '" data-day="' + k + '"><span><b>' + esc(k === today ? 'Hoy' : l.rel === l.txt.split(' ')[0] ? '' : l.rel) + '</b> ' + esc(l.txt) + '<br><small>' + ms.length + ' partidos</small></span><span class="badges">' + (hits ? '<span class="pill">✅ ' + hits + '</span>' : '') + (miss ? '<span class="pill none">❌ ' + miss + '</span>' : '') + '</span></button>';
      }
      $('weekList').innerHTML = h || '<div class="empty">Todavía no hay partidos guardados.</div>';
    });
  }

  // ---------- descargas ----------
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function say(t) { $('footMeta').textContent = t; }
  function stamp() { return dayKeyOf(new Date()); }

  function downloadXlsx() {
    if (!state.res || !state.res.months || !state.res.months.length) { say('Todavía no hay partidos guardados para exportar.'); return; }
    say('Preparando Excel…');
    loadAll().then(function () {
      var rows = window.RLX.matchesToRows(allMatches(), tz);
      var bytes = window.RLX.makeXlsx(rows, window.RLX.WIDTHS, 'Partidos');
      download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'pronosticos-' + stamp() + '.xlsx');
      say('Excel descargado (' + (rows.length - 1) + ' partidos).');
    });
  }
  function downloadClaude() {
    getJson('data/guia-claude.json', true).then(function (g) {
      if (!g) { say('No se pudo cargar la guía.'); return; }
      var now = Date.now();
      var open = (state.res && state.res.open) || [];
      g.generadoEn = new Date(now).toISOString();
      g.zonaHorariaUsuario = tz || 'America/Tijuana';
      g.abiertos = open.filter(function (o) { return Date.parse(o.kickoff) <= now; });
      g.yaAnalizadosProximos = open.filter(function (o) { return Date.parse(o.kickoff) > now; });
      download(new Blob([JSON.stringify(g, null, 1)], { type: 'application/json' }), 'claude-pendientes-' + stamp() + '.json');
      say('Archivo para Claude descargado (' + g.abiertos.length + ' partido(s) esperando resultado).');
    });
  }

  // ---------- eventos ----------
  document.addEventListener('click', function (e) {
    var t = e.target;
    var fm = t.closest && t.closest('[data-favm]');
    if (fm) {
      var id = fm.getAttribute('data-favm');
      var i = state.favs.m.indexOf(id);
      if (i >= 0) state.favs.m.splice(i, 1); else state.favs.m.push(id);
      saveFavs(); render(); return;
    }
    if (t.closest && t.closest('a')) return;
    var tg = t.closest && t.closest('[data-toggle]');
    if (tg) { var mid = tg.getAttribute('data-toggle'); state.open[mid] = !state.open[mid]; render(); return; }
    var dy = t.closest && t.closest('[data-day]');
    if (dy) { state.dayKey = dy.getAttribute('data-day'); $('weekSheet').hidden = true; ensureMonths(monthsFor(state.dayKey)).then(render); render(); return; }
    var ch = t.closest && t.closest('.chip');
    if (ch) {
      state.filter = ch.getAttribute('data-filter');
      document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('active', c === ch); });
      render();
    }
  });
  function go(key) { state.dayKey = key; ensureMonths(monthsFor(key)).then(render); render(); }
  $('prevDay').onclick = function () { go(addDays(state.dayKey, -1)); };
  $('nextDay').onclick = function () { go(addDays(state.dayKey, 1)); };
  $('todayBtn').onclick = function () { go(dayKeyOf(new Date())); };
  $('btnRefresh').onclick = function () { load(true); };
  $('btnWeek').onclick = function () { renderWeek(); $('weekSheet').hidden = false; };
  $('closeWeek').onclick = function () { $('weekSheet').hidden = true; };
  $('weekSheet').addEventListener('click', function (e) { if (e.target === $('weekSheet')) $('weekSheet').hidden = true; });
  $('search').addEventListener('input', function (e) { state.query = e.target.value; render(); });
  $('btnXlsx').onclick = downloadXlsx;
  $('btnClaude').onclick = downloadClaude;

  load(false);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* sin SW: la app sigue funcionando */ }); });
  }
})();
