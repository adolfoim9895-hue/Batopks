'use strict';
// Generador mínimo de .xlsx (sin dependencias): hoja única, cabecera en negrita, formato de cuota y de porcentaje.
// Se usa en el navegador (window.RLX) y se prueba en Node con vm.
(function (root) {
  var CRC = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function u16(v) { return [v & 255, (v >>> 8) & 255]; }
  function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }

  // ZIP sin compresión (método 0)
  function zip(files) {
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data);
      var local = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(local), name, data);
      central.push({ name: name, crc: crc, size: data.length, offset: offset });
      offset += local.length + name.length + data.length;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (e) {
      var h = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(e.crc), u32(e.size), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset));
      parts.push(new Uint8Array(h), e.name);
      cdSize += h.length + e.name.length;
    });
    parts.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0))));
    var total = parts.reduce(function (a, p) { return a + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  function xml(s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function col(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  // rows: arreglo de filas; cada celda: string | number | null | {v, fmt:'odds'|'pct'}
  function makeXlsx(rows, widths, sheetName) {
    var STYLE = { odds: 2, pct: 3 };
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    if (widths && widths.length) sheet += '<cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>';
    sheet += '<sheetData>';
    rows.forEach(function (r, ri) {
      sheet += '<row r="' + (ri + 1) + '">';
      r.forEach(function (cell, ci) {
        if (cell === null || cell === undefined || cell === '') return;
        var ref = col(ci) + (ri + 1);
        var v = cell, fmt = null;
        if (typeof cell === 'object') { v = cell.v; fmt = cell.fmt; }
        if (v === null || v === undefined || v === '') return;
        if (typeof v === 'number' && isFinite(v)) sheet += '<c r="' + ref + '"' + (fmt ? ' s="' + STYLE[fmt] + '"' : '') + '><v>' + v + '</v></c>';
        else sheet += '<c r="' + ref + '" t="inlineStr"' + (ri === 0 ? ' s="1"' : '') + '><is><t xml:space="preserve">' + xml(v) + '</t></is></c>';
      });
      sheet += '</row>';
    });
    sheet += '</sheetData></worksheet>';
    var name = xml(sheetName || 'Partidos').slice(0, 31);
    var files = [
      { name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
      { name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
      { name: 'xl/styles.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>') },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(sheet) },
    ];
    return zip(files);
  }

  var HEAD = ['Fecha', 'Hora', 'Torneo', 'País', 'Local', 'Visita', 'Cuota local (antes del partido)', '% Local', '% Empate', '% Visita', 'Pronóstico', 'Marcador probable',
    'Marcador final (90 min)', 'Marcador medio tiempo', 'Goles local (minutos)', 'Goles visita (minutos)', 'Secuencia de goles', 'Resultado real', 'Acierto', 'Estado', 'Analizado (UTC)', 'Origen del análisis'];
  var WIDTHS = [12, 7, 26, 14, 22, 22, 16, 9, 9, 9, 18, 12, 14, 14, 22, 22, 34, 14, 9, 20, 18, 22];

  function matchesToRows(matches, tz) {
    var d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    var t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    var rows = [HEAD];
    matches.slice().sort(function (a, b) { return a.kickoff < b.kickoff ? -1 : 1; }).forEach(function (m) {
      var dt = new Date(m.kickoff), r = m.result, ok = m.status === 'OK';
      var pick = !ok ? '' : m.favorite === 'home' ? 'Local' : m.favorite === 'away' ? 'Visita' : 'Empate';
      var real = r ? (r.home > r.away ? 'Local' : r.home < r.away ? 'Visita' : 'Empate') : '';
      var gl = function (team) { return r ? r.goals.filter(function (g) { return g.team === team; }).map(function (g) { return g.minute + "'" + (g.type === 'pen' ? ' (p)' : g.type === 'og' ? ' (e.p.c.)' : ''); }).join(', ') : ''; };
      var seq = '';
      if (r && r.goals.length) { var h = 0, a = 0; seq = r.goals.map(function (g) { if (g.team === 'home') h++; else a++; return h + '-' + a + ' (' + g.minute + "')"; }).join(' · '); }
      var estado = !ok ? 'DATOS INSUFICIENTES' : r ? 'Jugado' : (Date.now() > Date.parse(m.kickoff) ? 'Esperando resultado' : 'Próximo');
      rows.push([
        d.format(dt), t.format(dt), m.competition, m.country || '', m.home, m.away,
        m.homeOdds != null ? { v: m.homeOdds, fmt: 'odds' } : '',
        ok ? { v: Math.round(m.probs.home * 1000) / 1000, fmt: 'pct' } : '', ok ? { v: Math.round(m.probs.draw * 1000) / 1000, fmt: 'pct' } : '', ok ? { v: Math.round(m.probs.away * 1000) / 1000, fmt: 'pct' } : '',
        pick, ok && m.scores.length ? m.scores[0].score : '',
        r ? r.home + '-' + r.away : '', r && r.ht ? r.ht.home + '-' + r.ht.away : '', gl('home'), gl('away'), seq, real,
        m.hit === true ? 'SÍ' : m.hit === false ? 'NO' : '', estado, (m.analyzedAt || '').slice(0, 16).replace('T', ' '),
        m.origin && m.origin !== 'claude' ? (m.origin === 'chatgpt' ? 'ChatGPT (sin fuentes)' : m.origin === 'claude-parcial' ? 'Claude (fuentes parciales)' : m.origin) : 'Claude (con fuentes)',
      ]);
    });
    return rows;
  }

  root.RLX = { makeXlsx: makeXlsx, matchesToRows: matchesToRows, WIDTHS: WIDTHS, crc32: crc32 };
})(typeof globalThis !== 'undefined' ? globalThis : window);
