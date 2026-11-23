/*
 * Demo mode (index.html?demo): a fake backend with SIMULATED notes, and a time control.
 * Nothing here is real data. Every shift gets the same kinds of planted cases, so each state shows:
 * a missed check, a late check, a check just inside the grace time, no Laporan Shift, a body check at
 * the start, a patrol with no Mulai Shift, one late Mulai Shift, a missed Kembali, a point never
 * visited, no Akhir Shift, an incident, and one guard tour at a point not on the list.
 */
(function () {
  'use strict';
  var SA = window.SA, M = window.MONITOR;

  function seeded(text) {
    var s = 0;
    for (var i = 0; i < text.length; i++) s = (s * 31 + text.charCodeAt(i)) | 0;
    return function () {
      s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function at(base, min) {
    var d = new Date(base.getTime() + min * 60000);
    return SA.dateOf(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function notesFor(date, shiftId) {
    var r = seeded(date + shiftId);
    var w = SA.shiftWindow(date, shiftId), start = w.start, L = 480;
    var notes = [], n = 0;
    function note(o, min) {
      if (min == null) return;
      var id = 'demo-' + (n++);
      // most reports carry 1-3 photos; one in seven is still on its way (the phone sends photos after the note)
      var k = r() < 0.15 ? 0 : 1 + Math.floor(r() * 3);
      var photos = [];
      for (var i = 0; i < k; i++) photos.push({ no: i + 1, id: 'demofoto|' + (o.unit || '') + '|' + (i + 1) + '|' + at(start, min).slice(11, 16) });
      notes.push(Object.assign({ id: id, at: at(start, min), photos: photos }, o));
    }
    var pickCrew = function (list) { var i = Math.floor(r() * (list.length / 2)) * 2; return [list[i], list[i + 1] || list[0]]; };

    SA.SECURITY.posts.forEach(function (p, pi) {
      var crew = pickCrew(SA.SECURITY.roster[p.name] || ['PETUGAS 1', 'PETUGAS 2']);
      var base = { team: 'security', unit: p.name, zone: p.zone, officers: crew };
      var by = function () { return crew[r() < 0.5 ? 0 : 1]; };
      for (var c = 1; c <= 7; c++) {
        var min = c * 60 + 1 + r() * 13;
        if (pi === 0 && c === 4) min = null;            // missed
        if (pi === 7 && c === 2) min = null;            // missed
        if (pi === 3 && c === 3) min = c * 60 + 41.6;   // late
        if (pi === 9 && c === 4) min = c * 60 + 44.2;   // late, red for a few minutes first
        if (pi === 5 && c === 4) min = c * 60 + 29.5;   // just inside
        if (pi === 2 && c === 6) min = c * 60 + 35.4;   // late
        note(Object.assign({ kind: 'check', hour: SA.shiftById(shiftId).start + c, by: by() }, base), min);
      }
      if (pi === 4) note(Object.assign({ kind: 'check', hour: SA.shiftById(shiftId).start + 5, by: crew[1] }, base), 5 * 60 + 9.3);  // the partner's phone too
      note(Object.assign({ kind: 'shift', by: by() }, base), pi === 1 ? null : L - 10 + r() * 22);
      note(Object.assign({ kind: 'body', by: by() }, base), pi === 8 ? 10.3 : L - 80 + r() * 70);
      if (pi === 2) note(Object.assign({ kind: 'incident', by: crew[0] }, base), 2 * 60 + 47);
    });

    SA.PATROL.units.forEach(function (u, ui) {
      var crew = u.members.slice(0, 2);
      var base = { team: 'patrol', unit: u.id, zone: u.area, officers: crew };
      var by = function () { return crew[r() < 0.5 ? 0 : 1]; };
      note(Object.assign({ kind: 'pstart', by: crew[0] }, base), ui === 2 ? null : ui === 6 ? 52.4 : 5 + r() * 20);
      var pts = SA.patrolPoints(u.id), k = pts.length;
      pts.forEach(function (pt, i) {
        var out = 40 + (i + r() * 0.8) * (190 / k), back = 250 + ((k - 1 - i) + r() * 0.8) * (200 / k);
        if (ui === 4 && i === 6) { out = null; back = null; }
        if (ui === 3 && i === 2) back = null;
        note(Object.assign({ kind: 'patrol', point: pt.name, pass: 'Berangkat', by: by() }, base), out);
        note(Object.assign({ kind: 'patrol', point: pt.name, pass: 'Kembali', by: by() }, base), back);
      });
      if (ui === 1) note(Object.assign({ kind: 'patrol', point: 'Jembatan Kota Garo (Lainnya)', pass: 'Berangkat', by: crew[0] }, base), 150);
      note(Object.assign({ kind: 'pend', by: crew[0] }, base), ui === 7 ? null : L - 14 + r() * 24);
    });
    return notes;
  }

  window.MONITOR_DEMO = {
    board: function (date, shift) {
      return new Promise(function (ok) {
        setTimeout(function () { ok({ ok: true, time: SA.timestampOf(new Date()), notes: notesFor(date, shift) }); }, 250);
      });
    },
    /* A drawn stand-in, clearly marked, instead of a real photo. */
    photo: function (id) {
      var p = String(id).split('|');
      var hue = 90 + (p[1].length * 23 + Number(p[2]) * 40) % 120;
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + hue + ',30%,32%)"/>' +
        '<stop offset="1" stop-color="hsl(' + (hue + 40) + ',25%,16%)"/></linearGradient></defs>' +
        '<rect width="800" height="600" fill="url(#g)"/>' +
        '<text x="400" y="290" fill="#fff" font-family="Arial" font-size="54" font-weight="700" text-anchor="middle">FOTO SIMULASI</text>' +
        '<text x="400" y="350" fill="#fff" opacity=".8" font-family="Arial" font-size="30" text-anchor="middle">' +
        p[1].replace(/[<&]/g, '') + ' · foto ' + p[2] + ' · ' + p[3] + '</text></svg>';
      return new Promise(function (ok) {
        setTimeout(function () { ok({ ok: true, type: 'image/svg+xml', data: btoa(unescape(encodeURIComponent(svg))) }); }, 400);
      });
    }
  };

  /* The time control: a strip under the header. */
  var strip = document.createElement('div');
  strip.className = 'banner demo';
  strip.setAttribute('role', 'region');
  strip.setAttribute('aria-label', 'Kontrol demo');
  strip.innerHTML = '<strong style="font:700 15px var(--display);letter-spacing:.08em;text-transform:uppercase">Demo</strong>' +
    '<span>Data simulasi, bukan laporan sungguhan. Geser jam untuk melihat papan sepanjang hari.</span>' +
    '<label for="demo-time" style="margin-left:auto">Jam</label>' +
    '<input id="demo-time" type="range" min="0" max="1439" step="1" style="width:280px;accent-color:var(--amber-ink)">' +
    '<output id="demo-out" style="font:700 16px var(--display);min-width:44px"></output>' +
    '<button type="button" id="demo-play">Putar ×60</button><button type="button" id="demo-real">Jam sebenarnya</button>';
  var top = document.querySelector('.top');
  top.parentNode.insertBefore(strip, top.nextSibling);

  var range = strip.querySelector('#demo-time'), out = strip.querySelector('#demo-out'), play = strip.querySelector('#demo-play');
  var playing = false;
  function minutesNow() { var d = M.now(); return d.getHours() * 60 + d.getMinutes(); }
  function show() { var m = minutesNow(); range.value = m; out.textContent = pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function setMinutes(m) {
    var real = new Date(), target = new Date(real);
    target.setHours(Math.floor(m / 60), m % 60, 0, 0);
    M.offset = target - real;
    M.repaint();
    show();
  }
  range.addEventListener('input', function () { setMinutes(Number(range.value)); });
  play.addEventListener('click', function () { playing = !playing; play.textContent = playing ? 'Jeda' : 'Putar ×60'; });
  strip.querySelector('#demo-real').addEventListener('click', function () { M.offset = 0; playing = false; play.textContent = 'Putar ×60'; M.repaint(); show(); });
  setInterval(function () {
    if (playing) { M.offset += 59000; M.repaint(); }
    show();
  }, 1000);
  show();
})();
