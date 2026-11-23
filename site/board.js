/*
 * Monitor Laporan — the board.
 *
 * What is expected comes from the Laporan Tim app's own lists (options.js, patrol-options.js):
 * Security, per post: the hourly checks (start+1 .. end-1), Laporan Shift and Body Check at the end;
 * Patrol, per patrol: Mulai Shift at the start, every checkpoint twice (Berangkat, Kembali), Akhir Shift.
 * What arrived comes from the Apps Script: one note per saved report. A report is
 *   sent    a note exists (late when it came more than GRACE after it was due)
 *   wait    due, no note, still inside GRACE
 *   miss    due, no note, GRACE has passed
 *   future  not due yet
 * Checkpoints have no hour: they are due at the end of the shift.
 */
(function () {
  'use strict';

  var CFG = Object.assign({ API_URL: '', APP_URL: '', GRACE_MIN: 30, REFRESH_SEC: 60, STALE_MIN: 3 }, window.MONITOR_CONFIG || {});
  var DEMO = /[?&]demo(=|&|$)/.test(location.search);
  var GRACE = CFG.GRACE_MIN * 60000;
  var HOUR = 3600000;
  var PREV_WINDOW = 2 * HOUR;       // live: the last shift's missing reports stay in the list this long into the next
  var PASSES = ['Berangkat', 'Kembali'];
  var SA = null;

  var M = window.MONITOR = { offset: 0, now: function () { return new Date(Date.now() + M.offset); }, demo: DEMO };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hhmmss(d) { return hhmm(d) + ':' + pad(d.getSeconds()); }
  function dur(ms) { var m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? m + ' m' : Math.floor(m / 60) + ' j ' + pad(m % 60) + ' m'; }
  function icon(id) { return '<svg aria-hidden="true"><use href="#' + id + '"/></svg>'; }
  function title(s) { return String(s).charAt(0) + String(s).slice(1).toLowerCase(); }
  function shortName(n) { var w = String(n).split(' '); return w.length > 1 && n.length > 15 ? w[0] + ' ' + w[1].charAt(0) + '.' : n; }
  function parseAt(t) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(t || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
  }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function stored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  /* ------------------------------------------------------------------ boot */

  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = function () { bad(new Error(src)); };
      document.head.appendChild(s);
    });
  }

  function loadLists() {
    var base = !DEMO && CFG.APP_URL ? CFG.APP_URL.replace(/\/?$/, '/') + 'js/' : null;
    var copy = function () { return loadScript('lists/options.js').then(function () { return loadScript('lists/patrol-options.js'); }); };
    if (!base) return copy().then(function () { return 'copy'; });
    return loadScript(base + 'options.js').then(function () { return loadScript(base + 'patrol-options.js'); })
      .then(function () { return 'app'; })
      .catch(function () { window.SA = undefined; return copy().then(function () { return 'fallback'; }); });
  }

  function takeKey() {
    var m = /[#&]k=([^&]+)/.exec(location.hash);
    if (m) {
      store('monitorKey', decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);   // the key leaves the address bar
    }
    return stored('monitorKey') || '';
  }

  function gate(text, form) {
    $('app').hidden = true;
    $('gate').hidden = false;
    if (text) $('gate-text').textContent = text;
    $('gate-form').hidden = form === false;
  }
  $('gate-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var k = $('gate-key').value.trim().replace(/^.*#k=/, '');
    if (!k) return;
    store('monitorKey', k);
    location.reload();
  });

  var key = '';
  var api = null;

  function realApi() {
    return {
      board: function (date, shift) {
        var url = CFG.API_URL + '?action=board&k=' + encodeURIComponent(key) + '&date=' + date + '&shift=' + shift + '&_=' + Date.now();
        return fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) { return r.json(); });
      },
      photo: function (id) {
        var url = CFG.API_URL + '?action=photo&k=' + encodeURIComponent(key) + '&id=' + encodeURIComponent(id);
        return fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) { return r.json(); });
      }
    };
  }

  /* ------------------------------------------------------------------ shifts */

  var ORDER = ['MALAM', 'PAGI', 'SORE'];   // within one date

  function addDays(day, n) { var d = SA.parseDate(day); d.setDate(d.getDate() + n); return SA.dateOf(d); }
  function currentView() { var s = SA.shiftFor(M.now()); return { date: s.date, shift: s.shift }; }
  function step(v, dir) {
    var i = ORDER.indexOf(v.shift) + dir;
    if (i < 0) return { date: addDays(v.date, -1), shift: ORDER[2] };
    if (i > 2) return { date: addDays(v.date, 1), shift: ORDER[0] };
    return { date: v.date, shift: ORDER[i] };
  }
  function same(a, b) { return a && b && a.date === b.date && a.shift === b.shift; }
  function longDay(day) { return title(SA.longDate(SA.parseDate(day)).split(', ')[0]) + ', ' + SA.longDate(SA.parseDate(day)).split(', ')[1].toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  /* ------------------------------------------------------------------ model */

  function model(v, notes, now) {
    var shift = SA.shiftById(v.shift);
    var w = SA.shiftWindow(v.date, v.shift);
    var items = {}, order = [], units = {};
    function add(it) { it.hits = []; items[it.id] = it; order.push(it.id); return it; }
    function unit(name, team, zone, extra) {
      units[name] = Object.assign({ name: name, team: team, zone: zone, crew: [], crewAt: 0, incidents: [], offList: [], extras: 0 }, extra || {});
    }

    SA.SECURITY.posts.forEach(function (p) {
      unit(p.name, 'security', p.zone);
      var base = { team: 'security', unit: p.name, zone: p.zone };
      SA.checkHours(v.shift).forEach(function (h) {
        add(Object.assign({ id: p.name + '|c' + h, kind: 'check', col: h - shift.start, hour: h, due: SA.shiftHourDate(v.date, h),
          label: 'Cek jam ' + SA.hourText(h) }, base));
      });
      add(Object.assign({ id: p.name + '|shift', kind: 'shift', col: 8, due: w.end,
        label: 'Laporan Shift · serah terima ' + SA.hourText(shift.end) }, base));
      add(Object.assign({ id: p.name + '|body', kind: 'body', col: 9, due: w.end, label: 'Body Check' }, base));
    });

    var pointIndex = {};
    SA.PATROL.units.forEach(function (u) {
      unit(u.id, 'patrol', u.area, { segments: u.segments, car: SA.patrolVehicle ? SA.patrolVehicle(u.id) : '' });
      var base = { team: 'patrol', unit: u.id, zone: u.area };
      add(Object.assign({ id: u.id + '|start', kind: 'pstart', col: 0, due: w.start, label: 'Mulai Shift · KM awal' }, base));
      SA.patrolPoints(u.id).forEach(function (pt, i) {
        pointIndex[u.id + '|' + pt.name.toLowerCase()] = i;
        PASSES.forEach(function (pass, j) {
          add(Object.assign({ id: u.id + '|p' + i + (j ? 'k' : 'b'), kind: 'patrol', pt: i, pass: pass, point: pt.name, rawan: pt.rawan,
            due: w.end, label: pt.name + ' · ' + pass }, base));
        });
      });
      add(Object.assign({ id: u.id + '|end', kind: 'pend', col: 8, due: w.end, label: 'Akhir Shift · KM akhir' }, base));
    });

    var all = (notes || []).map(function (n) { return Object.assign({}, n, { when: parseAt(n.at) }); })
      .filter(function (n) { return n.when && (!DEMO || n.when <= now); })
      .sort(function (a, b) { return a.when - b.when; });

    all.forEach(function (n) {
      var name = n.team === 'security' ? SA.canonicalPost(n.unit) : n.unit;
      var u = units[name];
      if (!u) return;
      n.unitName = name;
      if (n.officers && n.officers.length && n.when >= u.crewAt) { u.crew = n.officers; u.crewAt = n.when; }
      var it = null;
      if (n.kind === 'check') it = items[name + '|c' + n.hour];
      else if (n.kind === 'shift' || n.kind === 'body') it = items[name + '|' + n.kind];
      else if (n.kind === 'pstart') it = items[name + '|start'];
      else if (n.kind === 'pend') it = items[name + '|end'];
      else if (n.kind === 'incident') u.incidents.push(n);
      else if (n.kind === 'patrol') {
        var i = pointIndex[name + '|' + SA.patrolPointName(n.point).toLowerCase()];
        if (i == null) u.offList.push(n);
        else if (n.pass === 'Kembali') it = items[name + '|p' + i + 'k'];
        else if (n.pass === 'Berangkat') it = items[name + '|p' + i + 'b'];
        else if (n.pass) u.extras++;                             // Tambahan: a third visit
        else it = items[name + '|p' + i + (items[name + '|p' + i + 'b'].hits.length ? 'k' : 'b')];   // before the two-pass rule
      }
      if (it) it.hits.push(n);
    });
    return { v: v, w: w, shift: shift, items: items, order: order, units: units, notes: all };
  }

  function stateOf(it, now) {
    var first = it.hits[0];
    if (first) return first.when - it.due > GRACE ? 'late' : 'sent';
    if (now < it.due) return 'future';
    if (now - it.due < GRACE) return 'wait';
    return 'miss';
  }
  function done(s) { return s === 'sent' || s === 'late'; }

  /* ------------------------------------------------------------------ view state */

  var view = {
    v: null, live: true, notes: null, prevNotes: null, prevV: null, okAt: 0, err: null, listSource: 'copy',
    zone: stored('monitorZone') || ''
  };
  var cells = {}, pipEls = {}, countEls = {}, unitEls = {}, painted = {}, lastState = {};
  var current = null;        // the model last painted

  /* ------------------------------------------------------------------ build (once per shift) */

  function axisHead(titleText, sub, extra, shift) {
    var h = el('div', 'sec-head');
    h.appendChild(el('h2', '', esc(titleText) + '<small>' + esc(sub) + '</small>'));
    for (var c = 0; c <= 8; c++) {
      var lab = c === 0 ? 'mulai' : c === 8 ? 'selesai' : '';
      var a = el('div', 'axis', pad((shift.start + c) % 24) + (lab ? '<small>' + lab + '</small>' : ''));
      a.dataset.col = c;
      h.appendChild(a);
    }
    h.appendChild(el('div', 'axis extra', esc(extra)));
    return h;
  }

  function cellFor(id) {
    var b = el('button', 'cell');
    b.type = 'button';
    b.addEventListener('click', function () { openItem(id); });
    cells[id] = b;
    return b;
  }

  function unitCell(name, team) {
    var box = el('div', 'unit');
    box.appendChild(el('b', '', esc(name)));
    var a = el('span'), b = el('span');
    box.appendChild(a);
    if (team === 'patrol') box.appendChild(b);
    var tag = el('button', 'tag');
    tag.type = 'button';
    tag.hidden = true;
    tag.addEventListener('click', function () { openIncidents(name); });
    box.appendChild(tag);
    unitEls[name] = { line1: a, line2: b, tag: tag };
    return box;
  }

  function zoneRow(zone) {
    var z = el('div', 'zone', '<b>' + esc(zone) + '</b><span>ARCO ' + esc((SA.SECURITY.arco || {})[zone] || arcoOf(zone)) + '</span>');
    z.dataset.zone = zone;
    return z;
  }
  function arcoOf(zone) {
    var names = { 'South Area': 'Dino Julivan · Yudi Hardianto', 'North Area': 'Dadang Kurnia · Deni Maulana' };
    return names[zone] || '';
  }

  function build(m) {
    cells = {}; pipEls = {}; countEls = {}; unitEls = {}; painted = {}; lastState = {};
    var secS = $('sec-security'), secP = $('sec-patrol');
    secS.innerHTML = ''; secP.innerHTML = '';
    var hours = SA.checkHours(m.v.shift).length;

    secS.appendChild(axisHead('Security Officer', SA.SECURITY.posts.length + ' pos · ' + hours + ' cek + laporan shift', 'Body check', m.shift));
    ['South Area', 'North Area'].forEach(function (zone) {
      secS.appendChild(zoneRow(zone));
      SA.SECURITY.posts.filter(function (p) { return p.zone === zone; }).forEach(function (p) {
        var row = el('div', 'row');
        row.dataset.zone = zone;
        row.appendChild(unitCell(p.name, 'security'));
        var none = el('div', 'cell none', '—');
        none.title = 'Cek pertama jam ' + SA.hourText(m.shift.start + 1);
        row.appendChild(none);
        SA.checkHours(m.v.shift).forEach(function (h) { row.appendChild(cellFor(p.name + '|c' + h)); });
        row.appendChild(cellFor(p.name + '|shift'));
        row.appendChild(cellFor(p.name + '|body'));
        secS.appendChild(row);
      });
    });

    secP.appendChild(axisHead('Patrol', SA.PATROL.units.length + ' patroli · tiap titik 2× per shift', 'Titik', m.shift));
    ['South Area', 'North Area'].forEach(function (zone) {
      secP.appendChild(zoneRow(zone));
      SA.PATROL.units.filter(function (u) { return u.area === zone; }).forEach(function (u) {
        var row = el('div', 'row');
        row.dataset.zone = zone;
        row.appendChild(unitCell(u.id, 'patrol'));
        row.appendChild(cellFor(u.id + '|start'));
        var strip = el('div', 'strip');
        pipEls[u.id] = SA.patrolPoints(u.id).map(function (pt, i) {
          var btn = el('button', 'pip' + (pt.rawan ? ' rawan' : ''));
          btn.type = 'button';
          var b = el('i'), k = el('i');
          btn.appendChild(b); btn.appendChild(k);
          btn.addEventListener('click', function () { openPoint(u.id, i); });
          strip.appendChild(btn);
          return { btn: btn, b: b, k: k, i: i };
        });
        var off = el('span', 'offlist');
        strip.appendChild(off);
        pipEls[u.id].off = off;
        row.appendChild(strip);
        row.appendChild(cellFor(u.id + '|end'));
        countEls[u.id] = el('div', 'count');
        row.appendChild(countEls[u.id]);
        secP.appendChild(row);
      });
    });
    applyZone();
  }

  /* ------------------------------------------------------------------ paint (every second) */

  function setOnce(key, node, cls, html, label) {
    var sig = cls + '|' + html + '|' + label;
    if (painted[key] === sig) return;
    painted[key] = sig;
    node.className = cls;
    node.innerHTML = html;
    if (label != null) { node.setAttribute('aria-label', label); node.title = label; }
  }

  function paintCell(it, now) {
    var s = stateOf(it, now), first = it.hits[0], html = '', label = it.unit + ', ' + it.label + ': ';
    if (s === 'sent') { html = icon('i-ok') + hhmm(first.when); label += 'masuk ' + hhmm(first.when); }
    else if (s === 'late') { html = hhmm(first.when) + '<em>telat ' + dur(first.when - it.due) + '</em>'; label += 'masuk ' + hhmm(first.when) + ', telat'; }
    else if (s === 'wait') { html = icon('i-wait') + '<em>' + dur(it.due.getTime() + GRACE - now) + ' lagi</em>'; label += 'menunggu'; }
    else if (s === 'miss') { html = icon('i-no') + '<em>+' + dur(now - it.due) + '</em>'; label += 'belum dikirim, lewat ' + dur(now - it.due); }
    else label += 'belum waktunya';
    var fresh = s === 'miss' && now - it.due - GRACE < 10 * 60000;     // red for under ten minutes: it pulses
    var node = cells[it.id];
    setOnce(it.id, node, 'cell s-' + s + (fresh ? ' fresh' : ''), html, label);
    arrived(it.id, s, node);
  }

  function arrived(id, s, node) {
    var was = lastState[id];
    lastState[id] = s;
    if (was && was !== s && done(s) && !done(was)) {
      node.classList.remove('arrived');
      void node.offsetWidth;
      node.classList.add('arrived');
    }
  }

  function paintUnits(m, now) {
    Object.keys(m.units).forEach(function (name) {
      var u = m.units[name], e = unitEls[name];
      if (!e) return;
      var crew = u.crew.length ? u.crew.join(' · ') : 'belum ada laporan';
      if (u.team === 'patrol') {
        e.line1.textContent = u.segments + (u.car ? ' · ' + u.car : '');
        e.line2.textContent = crew;
      } else e.line1.textContent = crew;
      e.line1.title = e.line1.textContent;
      if (u.incidents.length) {
        var last = u.incidents[u.incidents.length - 1];
        setOnce('tag|' + name, e.tag, 'tag', icon('i-alert') + 'Kejadian ' + hhmm(last.when) + (u.incidents.length > 1 ? ' (+' + (u.incidents.length - 1) + ')' : ''),
          name + ': ' + u.incidents.length + ' laporan kejadian shift ini');
        e.tag.hidden = false;
      } else e.tag.hidden = true;
    });
    SA.PATROL.units.forEach(function (u) {
      var pips = pipEls[u.id];
      if (!pips) return;
      var got = 0, total = 0;
      pips.forEach(function (p) {
        var ib = m.items[u.id + '|p' + p.i + 'b'], ik = m.items[u.id + '|p' + p.i + 'k'];
        var sb = stateOf(ib, now), sk = stateOf(ik, now);
        total += 2;
        if (done(sb)) got++;
        if (done(sk)) got++;
        var word = function (s, it) { return done(s) ? hhmm(it.hits[0].when) : s === 'miss' ? 'BELUM' : 'belum'; };
        var t = ib.point + (ib.rawan ? ' (titik rawan)' : '') + ' — Berangkat ' + word(sb, ib) + ', Kembali ' + word(sk, ik);
        var sig = sb + sk + t;
        if (painted['pip|' + u.id + p.i] !== sig) {
          painted['pip|' + u.id + p.i] = sig;
          p.b.className = 's-' + sb;
          p.k.className = 's-' + sk;
          p.btn.title = t;
          p.btn.setAttribute('aria-label', u.id + ': ' + t);
        }
      });
      var unit = m.units[u.id];
      pips.off.textContent = unit.offList.length ? '+' + unit.offList.length + ' lain' : '';
      pips.off.title = unit.offList.length ? unit.offList.length + ' guard tour di titik yang tidak ada di daftar (Lainnya)' : '';
      setOnce('count|' + u.id, countEls[u.id], 'count', got + '/' + total + '<small>pengecekan</small>', null);
    });
  }

  function inZone(z) { return !view.zone || z === view.zone; }

  function paint() {
    if (!view.v || !view.notes) return;
    var now = M.now();
    var m = current = model(view.v, view.notes, now);
    var n = { miss: 0, wait: 0, sent: 0, late: 0, future: 0 };
    m.order.forEach(function (id) {
      var it = m.items[id];
      if (cells[id]) paintCell(it, now);
      if (inZone(it.zone)) n[stateOf(it, now)]++;
    });
    paintUnits(m, now);

    $('n-miss').textContent = n.miss;
    $('n-miss').parentNode.classList.toggle('zero', n.miss === 0);
    $('n-wait').textContent = n.wait;
    $('n-sent').textContent = n.sent + n.late;
    $('n-late').textContent = n.late ? 'termasuk ' + n.late + ' telat' : '';
    $('n-future').textContent = n.future;
    var status = n.miss + ' laporan belum dikirim, ' + n.wait + ' menunggu, ' + (n.sent + n.late) + ' terkirim.';
    if ($('status-line').textContent !== status) $('status-line').textContent = status;

    var prev = view.live && view.prevNotes ? model(view.prevV, view.prevNotes, now) : null;
    paintAlerts(m, prev, now);
    paintFeed(m);
    paintClock(now);
    placeNow(m, now);
  }

  function paintAlerts(m, prev, now) {
    var groups = [];
    function collect(mm, previous) {
      var points = {};
      mm.order.forEach(function (id) {
        var it = mm.items[id];
        if (!inZone(it.zone) || stateOf(it, now) !== 'miss') return;
        if (it.kind === 'patrol') {
          if (!points[it.unit]) {
            points[it.unit] = { unit: it.unit, zone: it.zone, due: it.due, list: [], points: true, previous: previous, m: mm };
            groups.push(points[it.unit]);
          }
          points[it.unit].list.push(it);
        } else groups.push({ it: it, unit: it.unit, zone: it.zone, due: it.due, previous: previous, m: mm });
      });
    }
    if (prev && now - m.w.start < PREV_WINDOW) collect(prev, true);
    collect(m, false);
    groups.sort(function (a, b) { return a.due - b.due || (a.unit < b.unit ? -1 : 1); });

    var badge = $('alert-n');
    badge.textContent = groups.length;
    badge.classList.toggle('zero', groups.length === 0);
    var sig = groups.map(function (g) { return g.unit + (g.it ? g.it.id : g.list.length) + Math.floor((now - g.due) / 60000); }).join(',') + view.zone;
    if (painted.alerts === sig) return;
    painted.alerts = sig;

    var list = $('alerts');
    list.innerHTML = '';
    if (!groups.length) {
      list.appendChild(el('li', '', '<p class="empty good">Semua laporan yang sudah jadwalnya sudah masuk.</p>'));
      return;
    }
    groups.forEach(function (g) {
      var u = g.m.units[g.unit];
      var what = g.points
        ? g.list.length + ' pengecekan titik belum ada (' + g.list.map(function (x) { return x.pass; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' / ') + ')'
        : g.it.label;
      var b = el('button');
      b.type = 'button';
      b.innerHTML = '<b>' + esc(g.unit) + '</b><span class="late">+' + dur(now - g.due) + '</span>' +
        (g.previous ? '<span class="prevshift">Shift ' + esc(title(g.m.v.shift)) + ' (sebelumnya)</span>' : '') +
        '<span>' + esc(what) + '</span>' +
        '<span>Petugas: ' + esc(u.crew.length ? u.crew.map(shortName).join(', ') : 'tidak diketahui') + ' · ' + esc(g.zone.replace(' Area', '')) + '</span>';
      b.addEventListener('click', function () {
        if (g.points) openPoint(g.unit, g.list[0].pt, g.m);
        else openItem(g.it.id, g.m);
      });
      var li = el('li');
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function noteLabel(n) {
    if (n.kind === 'check') return 'Cek jam ' + SA.hourText(n.hour);
    if (n.kind === 'patrol') return (n.pass || 'Guard tour') + ' · ' + n.point;
    return { shift: 'Laporan Shift', body: 'Body Check', pstart: 'Mulai Shift', pend: 'Akhir Shift', incident: 'Laporan Kejadian',
      access: 'Access Control', close: 'Update temuan', lds: 'Laporan LDS' }[n.kind] || n.kind;
  }

  function paintFeed(m) {
    var got = m.notes.filter(function (n) { return n.unitName && inZone(m.units[n.unitName].zone); }).slice(-7).reverse();
    var sig = got.map(function (n) { return n.id; }).join(',');
    if (painted.feed === sig) return;
    painted.feed = sig;
    var list = $('feed');
    list.innerHTML = '';
    if (!got.length) { list.appendChild(el('li', '', '<span class="empty">Belum ada laporan di shift ini.</span>')); return; }
    got.forEach(function (n) {
      list.appendChild(el('li', '', '<time>' + hhmm(n.when) + '</time><b>' + esc(n.unitName) + '</b><span>' +
        esc(noteLabel(n)) + (n.by ? ' · ' + esc(n.by) : '') + '</span>'));
    });
  }

  function paintClock(now) {
    $('clock').innerHTML = hhmm(now) + '<small>:' + pad(now.getSeconds()) + '</small>';
    var conn = $('conn'), text;
    var stale = view.okAt && Date.now() - view.okAt > CFG.STALE_MIN * 60000;
    if (DEMO) { conn.className = 'conn wait'; text = 'Demo · data simulasi'; }
    else if (!view.okAt) { conn.className = view.err ? 'conn error' : 'conn wait'; text = view.err ? 'Tidak tersambung' : 'Menyambung…'; }
    else if (stale) { conn.className = 'conn stale'; text = 'Data terakhir ' + hhmm(new Date(view.okAt)); }
    else { conn.className = 'conn ok'; text = 'Tersambung · data ' + hhmm(new Date(view.okAt)); }
    if ($('conn-text').textContent !== text) $('conn-text').textContent = text;
    banner(stale);
  }

  function banner(stale) {
    var b = $('banner'), html = '';
    if (!view.live) {
      html = icon('i-prev') + '<span>Melihat shift lain — papan tidak mengikuti jam sekarang.</span><button type="button" data-act="live">Kembali ke langsung</button>';
    } else if (stale) {
      html = icon('i-alert') + '<span>Server tidak menjawab sejak ' + hhmm(new Date(view.okAt)) + '. Yang tampil adalah data terakhir; laporan baru belum terlihat.</span>';
    } else if (!DEMO && view.err && !view.okAt) {
      html = icon('i-alert') + '<span>Tidak bisa mengambil data: ' + esc(view.err.message || view.err) + '. Dicoba lagi tiap menit.</span>';
    }
    if (painted.banner === html) return;
    painted.banner = html;
    b.innerHTML = html;
    b.hidden = !html;
    var btn = b.querySelector('[data-act="live"]');
    if (btn) btn.addEventListener('click', goLive);
  }

  /* The sweep: the centre of column c is the shift's start + c hours; between centres it moves with the clock. */
  function placeNow(m, now) {
    var line = $('now');
    var on = view.live && now >= m.w.start - 30 * 60000 && now <= m.w.end.getTime() + GRACE;
    var head = document.querySelector('#sec-security .sec-head');
    var a0 = head && head.querySelector('.axis[data-col="0"]'), a8 = head && head.querySelector('.axis[data-col="8"]');
    if (!on || !a0 || !a0.offsetParent) { line.hidden = true; return; }
    line.hidden = false;
    var box = $('boards').getBoundingClientRect(), r0 = a0.getBoundingClientRect(), r8 = a8.getBoundingClientRect();
    var c0 = r0.left + r0.width / 2 - box.left, c8 = r8.left + r8.width / 2 - box.left, stepPx = (c8 - c0) / 8;
    var x = c0 + ((now - m.w.start) / HOUR) * stepPx;
    x = Math.max(c0 - stepPx / 2, Math.min(c8 + stepPx / 2, x));
    line.style.left = x.toFixed(1) + 'px';
    document.documentElement.style.setProperty('--step', Math.round(Math.min(stepPx, x - (c0 - stepPx / 2))) + 'px');
    var label = hhmm(now);
    if ($('now-label').textContent !== label) $('now-label').textContent = label;
    var col = Math.round((now - m.w.start) / HOUR);
    document.querySelectorAll('.axis.now-col').forEach(function (a) { if (Number(a.dataset.col) !== col) a.classList.remove('now-col'); });
    document.querySelectorAll('.sec-head .axis[data-col="' + col + '"]').forEach(function (a) { a.classList.add('now-col'); });
  }

  /* ------------------------------------------------------------------ detail */

  var dlg = $('detail');
  var STATUS = { sent: ['i-ok', 'Masuk'], late: ['i-ok', 'Masuk, telat'], wait: ['i-wait', 'Menunggu'], miss: ['i-no', 'Belum dikirim'], future: ['i-wait', 'Belum waktunya'] };
  function badge(s) { return '<span class="badge s-' + s + '">' + icon(STATUS[s][0]) + STATUS[s][1] + '</span>'; }
  function rows(pairs) { return '<dl>' + pairs.map(function (p) { return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>'; }).join('') + '</dl>'; }
  function shiftLine(m) { return 'Shift ' + title(m.v.shift) + ', ' + longDay(m.v.date); }
  function crewOf(m, unit) { var u = m.units[unit]; return u && u.crew.length ? u.crew.map(esc).join('<br>') : 'Belum ada laporan dari pos ini'; }
  function show(head, sub, body) {
    $('dlg-title').textContent = head;
    $('dlg-sub').textContent = sub;
    $('dlg-body').innerHTML = body;
    if (!dlg.open) dlg.showModal();
    loadPhotos();
  }

  /* Photos: each note lists its uploaded copies [{no, id}]; the picture itself is fetched only when a
     pop-up shows it, and kept for the session. The phone sends them after the note, so a report can be
     green with its photos still on the way. */
  var photoCache = {};
  function photoStrip(hits) {
    var all = [];
    hits.forEach(function (h) { (h.photos || []).forEach(function (p) { all.push({ id: p.id, no: p.no, by: h.by, when: h.when }); }); });
    if (!all.length) return hits.length ? '<p class="dlg-note">Foto belum masuk — HP mengirimnya setelah catatan, saat aplikasi terbuka dan ada sinyal.</p>' : '';
    return '<div class="photos">' + all.map(function (p) {
      return '<button type="button" class="ph" data-photo="' + esc(p.id) + '" aria-label="Foto ' + p.no + ', ' + esc(p.by || '') + ' ' + hhmm(p.when) +
        '"><span class="ph-wait">Memuat…</span></button>';
    }).join('') + '</div>';
  }
  function loadPhotos() {
    var body = $('dlg-body');
    body.querySelectorAll('[data-photo]').forEach(function (b) {
      var id = b.getAttribute('data-photo');
      b.addEventListener('click', function () { b.classList.toggle('big'); });
      var got = photoCache[id] || (photoCache[id] = api.photo(id).then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error || 'foto');
        return 'data:' + (res.type || 'image/jpeg') + ';base64,' + res.data;
      }));
      got.then(function (src) {
        if (!b.isConnected) return;
        b.innerHTML = '';
        var img = new Image();
        img.alt = b.getAttribute('aria-label');
        img.src = src;
        b.appendChild(img);
      }).catch(function () {
        delete photoCache[id];
        if (b.isConnected) b.innerHTML = '<span class="ph-wait">Gagal memuat</span>';
      });
    });
  }

  function openItem(id, m) {
    m = m || current;
    var it = m && m.items[id];
    if (!it) return;
    var now = M.now(), s = stateOf(it, now);
    var p = [['Status', badge(s)], ['Jadwal', hhmm(it.due)], ['Batas merah', hhmm(new Date(it.due.getTime() + GRACE))]];
    if (done(s)) {
      it.hits.forEach(function (h, i) {
        p.push([i ? 'Masuk lagi' : 'Masuk', hhmmss(h.when) + (i === 0 && s === 'late' ? ' (telat ' + dur(h.when - it.due) + ')' : '') +
          '<br><span style="font-weight:500;color:var(--ink-2)">' + esc(h.by || 'pelapor tidak diketahui') + '</span>']);
      });
    } else if (s === 'miss') p.push(['Terlambat', dur(now - it.due) + ' dari jadwal']);
    p.push(['Petugas', crewOf(m, it.unit)]);
    p.push(['ARCO ' + esc(it.zone.replace(' Area', '')), esc(arcoOf(it.zone)).replace(' · ', '<br>')]);
    var note = s === 'miss' ? '<p class="dlg-note">Belum ada catatan di server. Bisa jadi HP petugas belum dapat sinyal — catatan yang tertahan masuk sendiri begitu HP online dan aplikasinya dibuka.</p>' : '';
    show(it.unit, it.label + ' · ' + shiftLine(m), rows(p) + note + photoStrip(it.hits));
  }

  function openPoint(unit, i, m) {
    m = m || current;
    var ib = m.items[unit + '|p' + i + 'b'], ik = m.items[unit + '|p' + i + 'k'];
    if (!ib) return;
    var now = M.now();
    function pass(it) {
      var s = stateOf(it, now);
      return badge(s) + (done(s) ? ' ' + hhmm(it.hits[0].when) + (it.hits[0].by ? ' · ' + esc(it.hits[0].by) : '') : '');
    }
    var all = 0, got = 0;
    m.order.forEach(function (id) { var it = m.items[id]; if (it.unit === unit && it.kind === 'patrol') { all++; if (done(stateOf(it, now))) got++; } });
    var u = m.units[unit];
    var off = u.offList.length ? [['Di luar daftar', u.offList.map(function (n) { return hhmm(n.when) + ' ' + esc(n.point || 'Lainnya'); }).join('<br>')]] : [];
    show(unit, ib.point + (ib.rawan ? ' · titik rawan' : ''), rows([['Berangkat', pass(ib)], ['Kembali', pass(ik)],
      ['Patroli ini', got + ' dari ' + all + ' pengecekan'], ['Batas merah', hhmm(new Date(ib.due.getTime() + GRACE)) + ' (Akhir Shift + ' + CFG.GRACE_MIN + ' menit)'],
      ['Petugas', crewOf(m, unit)], ['Kendaraan', esc(u.car || '-')]].concat(off)) + photoStrip(ib.hits.concat(ik.hits)));
  }

  function openIncidents(unit) {
    var m = current, u = m && m.units[unit];
    if (!u || !u.incidents.length) return;
    show(unit, 'Laporan kejadian · ' + shiftLine(m), rows(u.incidents.map(function (n) {
      return [hhmm(n.when), esc(n.by || '-')];
    })) + '<p class="dlg-note">Isi kejadiannya ada di WhatsApp dan di Excel shift ini; papan hanya mencatat bahwa laporannya sudah dibuat.</p>');
  }

  $('dlg-close').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });

  /* ------------------------------------------------------------------ data */

  var loading = 0;
  function load() {
    var v = view.v, token = ++loading;
    var prevV = step(v, -1);
    var wantPrev = view.live && M.now() - SA.shiftWindow(v.date, v.shift).start < PREV_WINDOW;
    return Promise.all([api.board(v.date, v.shift), wantPrev ? api.board(prevV.date, prevV.shift) : Promise.resolve(null)])
      .then(function (res) {
        if (token !== loading) return;
        var a = res[0], b = res[1];
        if (!a || !a.ok) {
          if (a && a.error === 'key') { store('monitorKey', null); gate('Kunci papan tidak cocok atau sudah diganti. Buka tautan papan yang baru.'); return; }
          throw new Error(a && a.error || 'jawaban kosong');
        }
        view.notes = a.notes || [];
        view.prevNotes = b && b.ok ? b.notes : null;
        view.prevV = prevV;
        view.okAt = Date.now();
        view.err = null;
        paint();
      })
      .catch(function (e) {
        if (token !== loading) return;
        view.err = e;
        if (!view.notes) { view.notes = []; paint(); }
        paintClock(M.now());
      });
  }

  function setView(v, live) {
    var changed = !same(v, view.v);
    view.v = v;
    view.live = live;
    $('live').setAttribute('aria-pressed', String(live));
    $('next').disabled = same(v, currentView());
    var sh = SA.shiftById(v.shift);
    $('shift-name').textContent = 'Shift ' + title(v.shift) + ' · ' + pad(sh.start) + '.00 – ' + pad(sh.end % 24) + '.00';
    $('shift-date').textContent = longDay(v.date);
    if (changed) {
      view.notes = null;
      view.prevNotes = null;
      build(model(v, [], M.now()));
      $('now').classList.remove('moving');
      load().then(function () { setTimeout(function () { $('now').classList.add('moving'); }, 700); });
    }
    painted.banner = null;
  }

  function goLive() { setView(currentView(), true); paint(); }

  /* ------------------------------------------------------------------ controls */

  function applyZone() {
    document.querySelectorAll('.zones button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.zone === view.zone)); });
    document.querySelectorAll('.row, .zone').forEach(function (r) { r.hidden = !!view.zone && r.dataset.zone !== view.zone; });
  }

  function wire() {
    document.querySelectorAll('.zones button').forEach(function (b) {
      b.addEventListener('click', function () {
        view.zone = b.dataset.zone;
        store('monitorZone', view.zone || null);
        applyZone();
        painted = {};
        paint();
      });
    });
    $('prev').addEventListener('click', function () { setView(step(view.v, -1), false); });
    $('next').addEventListener('click', function () {
      var n = step(view.v, 1);
      if (same(n, currentView())) goLive(); else setView(n, false);
    });
    $('live').addEventListener('click', goLive);
    $('theme').addEventListener('click', function () {
      var t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      store('monitorTheme', t);
    });
    $('full').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    });
    window.addEventListener('resize', function () { if (current) placeNow(current, M.now()); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && view.v) load(); });
    document.querySelectorAll('.grace').forEach(function (g) { g.textContent = CFG.GRACE_MIN; });
  }

  M.refresh = function () { painted = {}; return load(); };
  M.repaint = function () {
    if (view.live && !same(view.v, currentView())) setView(currentView(), true);
    paint();
  };

  function start(source) {
    SA = window.SA;
    view.listSource = source;
    document.documentElement.dataset.theme = stored('monitorTheme') || 'dark';
    $('gate').hidden = true;
    $('app').hidden = false;
    $('lists-note').textContent = source === 'app' ? '' : source === 'fallback'
      ? 'Daftar pos dan titik: salinan (aplikasi tidak bisa dibuka dari APP_URL).'
      : 'Daftar pos dan titik: salinan dari aplikasi v58 (23 Nov 2026).';
    wire();
    setView(currentView(), true);

    setInterval(function () {
      if (view.live && !same(view.v, currentView())) setView(currentView(), true);
      paint();
    }, 1000);
    setInterval(function () { if (!document.hidden) load(); }, CFG.REFRESH_SEC * 1000);
  }

  /* ------------------------------------------------------------------ go */

  document.documentElement.dataset.theme = stored('monitorTheme') || 'dark';
  if (DEMO) {
    loadLists().then(function (source) {
      return loadScript('demo.js').then(function () { api = window.MONITOR_DEMO; start(source); });
    });
  } else {
    key = takeKey();
    if (!CFG.API_URL) gate('Alamat server belum diisi. Isi API_URL di config.js (lihat README, langkah 3).', false);
    else if (!key) gate();
    else loadLists().then(function (source) { api = realApi(); start(source); });
  }
})();
