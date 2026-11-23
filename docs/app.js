'use strict';
(function () {
  var DATA_URL = 'data/predictions.json';
  var state = { data: null, dayKey: null, filter: 'all', query: '', favs: loadFavs(), open: {}, hist: {}, summary: null };
  var tz = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return undefined; } })();
  var $ = function (id) { return document.getElementById(id); };

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem('rl_favs') || '{"m":[],"l":[]}'); } catch (e) { return { m: [], l: [] }; }
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
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
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
  function days() {
    var today = dayKeyOf(new Date());
    var out = [];
    for (var i = -30; i <= 7; i++) out.push(addDays(today, i));
    return out;
  }
  function weekDays() {
    var today = dayKeyOf(new Date());
    var out = [];
    for (var i = 0; i <= 7; i++) out.push(addDays(today, i));
    return out;
  }

  // ---------- porcentajes enteros que suman 100 ----------
  function pcts(p) {
    var v = [p.home, p.draw, p.away].map(function (x) { return x * 100; });
    var f = v.map(Math.floor);
    var rest = 100 - f.reduce(function (a, b) { return a + b; }, 0);
    v.map(function (x, i) { return [x - f[i], i]; }).sort(function (a, b) { return b[0] - a[0]; }).slice(0, rest).forEach(function (r) { f[r[1]]++; });
    return f;
  }
  var pc = function (x) { return Math.round(x * 100) + '%'; };

  // ---------- datos ----------
  function load(force) {
    var btn = $('btnRefresh');
    btn.classList.add('spin');
    return fetch(DATA_URL + (force ? '?t=' + Date.now() : ''), { cache: force ? 'reload' : 'default' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { state.data = d; if (!state.dayKey) state.dayKey = dayKeyOf(new Date()); render(); })
      .catch(function (e) {
        $('list').innerHTML = '<div class="empty"><b>No se pudieron cargar los pronósticos.</b><br>' + esc(e.message) + '</div>';
      })
      .then(function () { setTimeout(function () { btn.classList.remove('spin'); }, 300); });
  }

  // ---------- historial (un archivo por mes) ----------
  function monthsFor(key) {
    var a = [key.slice(0, 7), addDays(key, -1).slice(0, 7), addDays(key, 1).slice(0, 7)];
    return a.filter(function (m, i) { return a.indexOf(m) === i; });
  }
  function ensureHist(key) {
    var need = monthsFor(key).filter(function (mk) { return !(mk in state.hist); });
    if (!need.length) return;
    need.forEach(function (mk) { state.hist[mk] = null; });
    Promise.all(need.map(function (mk) {
      return fetch('data/history/' + mk + '.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    })).then(function (res) { need.forEach(function (mk, i) { state.hist[mk] = res[i]; }); render(); });
  }
  function histOfDay(key) {
    var out = [];
    monthsFor(key).forEach(function (mk) {
      var h = state.hist[mk];
      if (h && h.matches) Object.keys(h.matches).forEach(function (id) {
        var r = h.matches[id];
        if (dayKeyOf(new Date(r.kickoff)) === key) out.push(r);
      });
    });
    return out;
  }
  function hitOf(m) {
    if (!m.result || m.dataStatus !== 'OK' || !m.favorite || !m.probs) return null;
    var o = m.result.home > m.result.away ? 'home' : m.result.home < m.result.away ? 'away' : 'draw';
    return o === m.favorite;
  }
  function loadSummary() {
    fetch('data/history/summary.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) { state.summary = s; renderRecord(); }).catch(function () { /* sin historial todavía */ });
  }
  function renderRecord() {
    var box = $('recordBox');
    var s = state.summary;
    if (!s || !s.totals || !s.totals.n) {
      box.innerHTML = '<b>Récord real de aciertos</b><br><span class="muted">Aún no hay partidos evaluados. Se llena solo: cada pronóstico se guarda antes del partido y se compara con el resultado final.</span>' + (s && s.pending ? '<br><span class="muted">' + s.pending + ' pronóstico(s) guardado(s) esperando resultado.</span>' : '');
      return;
    }
    var t = s.totals;
    function line(label, x) {
      if (!x.n) return '';
      return '<div>' + label + ': <b>' + x.hits + '/' + x.n + ' (' + Math.round(100 * x.hits / x.n) + '%)</b> <span class="muted">· el modelo esperaba ' + Math.round(100 * x.sumPred / x.n) + '%</span></div>';
    }
    box.innerHTML = '<b>Récord real de aciertos</b> <span class="muted">(pronósticos guardados antes del partido)</span>' +
      line('Confianza alta', t.byTier.alta) + line('Confianza media', t.byTier.media) + line('Sin nivel', t.byTier.none) +
      '<div>Total: <b>' + t.hits + '/' + t.n + ' (' + Math.round(100 * t.hits / t.n) + '%)</b>' + (s.pending ? ' <span class="muted">· ' + s.pending + ' pendiente(s)</span>' : '') + '</div>';
  }

  function matchesOfDay(key) {
    if (!state.data) return [];
    if (key < dayKeyOf(new Date())) return histOfDay(key);
    return state.data.matches.filter(function (m) { return dayKeyOf(new Date(m.kickoff)) === key; });
  }
  function isFav(m) { return state.favs.m.indexOf(m.id) >= 0 || state.favs.l.indexOf(m.competition.key) >= 0; }
  function passes(m) {
    var f = state.filter;
    if (f === 'fav' && !isFav(m)) return false;
    if (f === 'alta' && m.confidence.tier !== 'alta') return false;
    if (f === 'media' && m.confidence.tier !== 'media') return false;
    var q = state.query.trim().toLowerCase();
    if (q) {
      var hay = (m.home.name + ' ' + m.away.name + ' ' + m.competition.name + ' ' + m.competition.country).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  // ---------- render ----------
  function crest(t) {
    var ini = esc((t.name || '?').replace(/[^A-Za-zÀ-ÿ0-9 ]/g, '').split(' ').slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase());
    if (t.crest && safeUrl(t.crest)) return '<img class="crest" loading="lazy" alt="" src="' + esc(t.crest) + '" data-ini="' + ini + '">';
    return '<span class="crest ph">' + ini + '</span>';
  }
  function formBadges(seq) {
    if (!seq) return '<span class="muted">—</span>';
    return '<span class="form">' + seq.split('').map(function (c) { return '<i class="' + c + '">' + ({ W: 'V', D: 'E', L: 'D' })[c] + '</i>'; }).join('') + '</span>';
  }

  function cardHtml(m) {
    var open = !!state.open[m.id];
    var fav = state.favs.m.indexOf(m.id) >= 0;
    var h = '<article class="card' + (open ? ' open' : '') + '" data-id="' + esc(m.id) + '">';
    h += '<div class="row" data-toggle="' + esc(m.id) + '">';
    h += '<div class="time">' + (m.timeApprox ? '<span title="Hora no confirmada">~</span>' : '') + timeOf(m.kickoff) + (m.timeApprox ? '<small>hora por confirmar</small>' : '') + '</div>';
    h += '<div class="teams">';
    h += '<div class="team">' + crest(m.home) + '<span class="n">' + esc(m.home.name) + '</span>' + (m.result ? '<span class="score">' + m.result.home + '</span>' : '') + '</div>';
    h += '<div class="team">' + crest(m.away) + '<span class="n">' + esc(m.away.name) + '</span>' + (m.result ? '<span class="score">' + m.result.away + '</span>' : '') + '</div>';
    h += '</div>';
    h += '<button class="cardStar' + (fav ? ' on' : '') + '" data-favm="' + esc(m.id) + '" aria-label="Favorito">' + (fav ? '★' : '☆') + '</button>';
    h += '</div>';

    if (m.dataStatus !== 'OK') {
      h += '<div class="noData">DATOS INSUFICIENTES<small>' + esc(m.insufficientReason || '') + '</small></div>';
    } else {
      var p = pcts(m.probs);
      h += '<div class="bar" role="img" aria-label="Local ' + p[0] + '%, empate ' + p[1] + '%, visita ' + p[2] + '%"><i class="h" style="width:' + p[0] + '%"></i><i class="d" style="width:' + p[1] + '%"></i><i class="a" style="width:' + p[2] + '%"></i></div>';
      h += '<div class="legend"><span>Local <b>' + p[0] + '%</b></span><span>Empate <b>' + p[1] + '%</b></span><span>Visita <b>' + p[2] + '%</b></span></div>';
      var favName = m.favorite === 'home' ? m.home.name : m.favorite === 'away' ? m.away.name : null;
      var favP = m.favorite === 'home' ? p[0] : m.favorite === 'away' ? p[2] : p[1];
      h += '<div class="pick"><div class="t">' + (favName ? 'Gana ' + esc(favName) + ' · ' + favP + '%' : 'Empate · ' + favP + '%') + '<em>Marcador probable ' + esc(m.scores[0].score) + '</em></div>';
      var t = m.confidence.tier;
      h += t ? '<span class="pill ' + t + '">Confianza ' + t + '</span>' : '<span class="pill none">Sin nivel</span>';
      h += '</div>';
      var hit = hitOf(m);
      if (hit !== null) h += '<div class="resLine ' + (hit ? 'ok' : 'bad') + '">' + (hit ? '✅ Acertó' : '❌ Falló') + ' · Final ' + m.result.home + '-' + m.result.away + '</div>';
      var w = (m.warnings || [])[0];
      if (w) h += '<div class="warnLine">' + esc(w.text) + '</div>';
    }
    if (open) h += detailHtml(m);
    h += '</article>';
    return h;
  }

  function kv(label, val) { return '<div class="kv"><span>' + esc(label) + '</span><b>' + val + '</b></div>'; }

  function detailHtml(m) {
    var h = '<div class="detail">';
    if (m.dataStatus === 'OK') {
      h += '<h3>Probabilidades y goles</h3><div class="grid">';
      h += kv('Goles esperados', esc(m.xg.home) + ' – ' + esc(m.xg.away));
      h += kv('Ambos anotan', pc(m.goals.btts));
      h += kv('Más de 0.5 / 1.5', pc(m.goals.over05) + ' / ' + pc(m.goals.over15));
      h += kv('Más de 2.5', pc(m.goals.over25));
      h += '</div><h3>Marcadores más probables</h3><div class="scores">' + m.scores.map(function (s) { return '<span>' + esc(s.score) + '<small>' + pc(s.p) + '</small></span>'; }).join('') + '</div>';
      h += '<h3>Forma reciente</h3>';
      h += '<div>' + esc(m.home.name) + ' ' + formBadges(m.home.form && m.home.form.seq) + '</div>';
      h += '<div style="margin-top:6px">' + esc(m.away.name) + ' ' + formBadges(m.away.form && m.away.form.seq) + '</div>';
      h += '<h3>Confianza</h3><div>' + esc(m.confidence.reason || '') + '</div>';
      if (m.confidence.bucket && m.confidence.bucket.n) h += '<div class="muted">Histórico validado del tramo: ' + pc(m.confidence.bucket.actual) + ' de victorias locales (n=' + m.confidence.bucket.n + ').</div>';
    }
    if ((m.warnings || []).length) h += '<h3>Advertencias</h3>' + m.warnings.map(function (w) { return '<div class="warnLine">' + esc(w.text) + '</div>'; }).join('');
    if ((m.explain || []).length) h += '<h3>Explicación</h3><ul>' + m.explain.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    if (m.ai) {
      h += '<h3>Bajas, rotaciones y alineaciones (IA con búsqueda web)</h3>';
      if (m.ai.status === 'OK') {
        var list = (m.ai.injuries || []).concat(m.ai.suspensions || []);
        h += list.length ? '<ul>' + list.map(function (c) { return '<li>' + (c.team === 'home' ? esc(m.home.name) : esc(m.away.name)) + ': ' + esc(c.player) + ' — ' + (c.status === 'out' ? 'baja' : 'duda') + (c.detail ? ' (' + esc(c.detail) + ')' : '') + (c.source_date ? ' · fuente del ' + esc(c.source_date) : '') + '</li>'; }).join('') + '</ul>' : '<div class="muted">Sin bajas verificadas.</div>';
        h += '<div class="muted">Rotaciones: ' + esc(m.ai.rotation.level) + (m.ai.rotation.reason ? ' — ' + esc(m.ai.rotation.reason) : '') + '. Alineación confirmada: ' + (m.ai.lineup.confirmed ? 'sí' : 'no') + '.</div>';
      } else {
        h += '<div class="muted">DATOS INSUFICIENTES (' + esc(m.ai.status) + ').</div>';
      }
      if (m.ai.consultedAt) h += '<div class="muted">Consultado: ' + esc(m.ai.consultedAt.slice(0, 16).replace('T', ' ')) + ' UTC</div>';
    }
    if ((m.h2h || []).length) h += '<h3>Enfrentamientos directos</h3><ul>' + m.h2h.map(function (x) { return '<li>' + esc(x.date) + ' · ' + esc(x.home) + ' ' + esc(x.score) + ' ' + esc(x.away) + '</li>'; }).join('') + '</ul>';
    var srcs = (m.sources || []).concat((m.ai && m.ai.sources) || []);
    if (srcs.length) {
      h += '<h3>Fuentes consultadas</h3><ul class="src">' + srcs.map(function (s) {
        var u = safeUrl(s.url);
        var name = esc(s.title || s.name || s.url);
        return '<li>' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + name + '</a>' : name) + (s.date ? ' · ' + esc(String(s.date).slice(0, 10)) : '') + '</li>';
      }).join('') + '</ul>';
    }
    return h + '</div>';
  }

  function render() {
    var d = state.data;
    if (!d) return;
    var key = state.dayKey;
    var lb = labelFor(key);
    $('dayRel').textContent = lb.rel;
    $('dayDate').textContent = lb.txt;
    var ds = days();
    $('prevDay').disabled = key <= ds[0];
    $('nextDay').disabled = key >= ds[ds.length - 1];

    var banner = $('banner');
    var age = (Date.now() - Date.parse(d.generatedAt)) / 36e5;
    var msgs = [];
    var cls = 'banner';
    if (d.placeholder || !d.matches.length && age > 24 * 365) { msgs.push('Aún no hay datos generados. Ejecuta el workflow "Actualizar y publicar" en GitHub Actions (ver README).'); cls += ' err'; }
    else {
      if (age > 36) msgs.push('Los datos tienen ' + Math.round(age) + ' h de antigüedad: la última actualización automática pudo fallar.');
      if (d.validation && !d.validation.skillOK) msgs.push('Validación histórica insuficiente: se muestran probabilidades, pero no se asignan niveles de confianza.');
      var live = (d.sources || []).filter(function (s) { return s.status === 'ok' || s.status === 'parcial'; });
      var bad = (d.sources || []).filter(function (s) { return s.status === 'error'; });
      if (!live.length) { msgs.push('Ninguna fuente de datos respondió en la última actualización.'); cls += ' err'; }
      else if (bad.length) msgs.push('Fuente(s) con fallo en la última actualización: ' + bad.map(function (s) { return s.name; }).join(', ') + ' (la app sigue con las demás).');
    }
    banner.hidden = !msgs.length;
    banner.className = cls;
    banner.textContent = msgs.join(' ');

    if (key < dayKeyOf(new Date())) ensureHist(key);
    var ms = matchesOfDay(key).filter(passes);
    var byLeague = {};
    ms.forEach(function (m) { (byLeague[m.competition.key] = byLeague[m.competition.key] || { c: m.competition, items: [] }).items.push(m); });
    var groups = Object.keys(byLeague).map(function (k) { return byLeague[k]; }).sort(function (a, b) { return a.c.order - b.c.order; });
    var h = '';
    groups.forEach(function (g) {
      var on = state.favs.l.indexOf(g.c.key) >= 0;
      h += '<section class="league"><div class="leagueHead"><h2>' + esc(g.c.name) + '<small>' + esc(g.c.country) + '</small></h2><button class="star' + (on ? ' on' : '') + '" data-favl="' + esc(g.c.key) + '" aria-label="Liga favorita">' + (on ? '★' : '☆') + '</button></div>';
      g.items.sort(function (a, b) { return Date.parse(a.kickoff) - Date.parse(b.kickoff); }).forEach(function (m) { h += cardHtml(m); });
      h += '</section>';
    });
    if (!h) {
      var total = matchesOfDay(key).length;
      var past = key < dayKeyOf(new Date());
      h = past && !total ? '<div class="empty"><b>No hay pronósticos guardados para este día.</b><br>El historial empieza a llenarse desde la primera actualización con esta versión.</div>' : '<div class="empty">' + (total ? '<b>Ningún partido coincide con el filtro.</b><br>Hay ' + total + ' partido(s) este día.' : '<b>No hay partidos analizados para este día.</b><br>Solo se muestran ligas con datos verificables en las fuentes configuradas.') + '</div>';
    }
    $('list').innerHTML = h;

    $('footMeta').textContent = 'Datos generados: ' + new Date(d.generatedAt).toLocaleString('es', { timeZone: tz }) + ' · ' + d.counts.total + ' partidos en la semana (alta ' + d.counts.alta + ', media ' + d.counts.media + ')';
    var s = '';
    (d.sources || []).forEach(function (x) {
      s += '<div><b>' + esc(x.name) + '</b>: ' + esc(x.status) + (x.fetchedAt ? ' · ' + esc(x.fetchedAt.slice(0, 16).replace('T', ' ')) + ' UTC' : '') + '<br><span class="muted">' + esc(x.detail || '') + '</span></div>';
    });
    if (d.validation && d.validation.n) {
      s += '<div style="margin-top:8px"><b>Validación histórica</b> (walk-forward, n=' + d.validation.n + '): Brier ' + d.validation.brier.toFixed(3) + ' vs referencia ' + d.validation.baselineBrier.toFixed(3) + ' → ' + (d.validation.skillOK ? 'el modelo supera la referencia' : 'NO validado') + '</div>';
    }
    $('sourcesList').innerHTML = s;
  }

  function renderWeek() {
    var today = dayKeyOf(new Date());
    var h = '';
    weekDays().forEach(function (k) {
      var ms = matchesOfDay(k);
      var a = ms.filter(function (m) { return m.confidence.tier === 'alta'; }).length;
      var me = ms.filter(function (m) { return m.confidence.tier === 'media'; }).length;
      var l = labelFor(k);
      h += '<button class="wrow' + (k === state.dayKey ? ' cur' : '') + '" data-day="' + k + '"><span><b>' + esc(k === today ? 'Hoy' : l.rel === l.txt.split(' ')[0] ? '' : l.rel) + '</b> ' + esc(l.txt) + '<br><small>' + ms.length + ' partidos</small></span><span class="badges">' + (a ? '<span class="pill">alta ' + a + '</span>' : '') + (me ? '<span class="pill media">media ' + me + '</span>' : '') + '</span></button>';
    });
    $('weekList').innerHTML = h;
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
    var fl = t.closest && t.closest('[data-favl]');
    if (fl) {
      var k = fl.getAttribute('data-favl');
      var j = state.favs.l.indexOf(k);
      if (j >= 0) state.favs.l.splice(j, 1); else state.favs.l.push(k);
      saveFavs(); render(); return;
    }
    var tg = t.closest && t.closest('[data-toggle]');
    if (tg) {
      var mid = tg.getAttribute('data-toggle');
      state.open[mid] = !state.open[mid];
      render(); return;
    }
    var dy = t.closest && t.closest('[data-day]');
    if (dy) { state.dayKey = dy.getAttribute('data-day'); $('weekSheet').hidden = true; render(); return; }
    var ch = t.closest && t.closest('.chip');
    if (ch) {
      state.filter = ch.getAttribute('data-filter');
      document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('active', c === ch); });
      render();
    }
  });
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('crest')) {
      var s = document.createElement('span');
      s.className = 'crest ph';
      s.textContent = img.getAttribute('data-ini') || '?';
      img.replaceWith(s);
    }
  }, true);
  $('prevDay').onclick = function () { state.dayKey = addDays(state.dayKey, -1); render(); };
  $('nextDay').onclick = function () { state.dayKey = addDays(state.dayKey, 1); render(); };
  $('todayBtn').onclick = function () { state.dayKey = dayKeyOf(new Date()); render(); };
  $('btnRefresh').onclick = function () { state.hist = {}; load(true); loadSummary(); };
  $('btnWeek').onclick = function () { renderWeek(); $('weekSheet').hidden = false; };
  $('closeWeek').onclick = function () { $('weekSheet').hidden = true; };
  $('weekSheet').addEventListener('click', function (e) { if (e.target === $('weekSheet')) $('weekSheet').hidden = true; });
  $('search').addEventListener('input', function (e) { state.query = e.target.value; render(); });

  load(false);
  loadSummary();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* sin SW: la app sigue funcionando */ }); });
  }
})();
