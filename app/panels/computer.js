'use strict';
// Wave B: Live Computer sessions panel (follow-along view of W5 sessions).
// textContent-only; uses window.TG surface; registers into TG_PANELS.
(function () {
  function render(host, TG) {
    var P = window.TG || TG;
    host.textContent = '';
    var h = P.el('h3', null, 'Live computer sessions');
    var list = P.el('div', 'comp-list');
    var detail = P.el('div', 'comp-detail');
    var sel = null; // session id

    function open(id) {
      sel = id;
      P.api('/v2/computer/' + id).then(function (d) {
        var s = d.session || d;
        detail.textContent = '';
        detail.appendChild(P.el('h3', null, (s.label || s.id) + ' — ' + (s.bot || '?')));
        detail.appendChild(P.el('div', 'comp-state state-' + s.state, s.state));

        // ── human control bar (P1 takeover-flow): inspect=pause, release=hands back ──
        var bar = P.el('div', 'comp-control');
        function control(action) {
          return function () {
            P.api('/v2/computer/' + sel + '/control', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: action }),
            }).then(function () { open(sel); })
              .catch(function () { detail.appendChild(P.el('div', 'comp-error', 'control refused (operator required?)')); });
          };
        }
        if (s.state !== 'awaiting-human') {
          var takeBtn = P.el('button', 'comp-btn comp-takeover', 'Takeover (pause bot)');
        takeBtn.setAttribute('aria-label', 'Take over computer session ' + sel + ' — pauses the bot');
          takeBtn.addEventListener('click', control('takeover'));
          bar.appendChild(takeBtn);
        } else {
          var relBtn = P.el('button', 'comp-btn comp-release', 'Release (hand back to agent)');
        relBtn.setAttribute('aria-label', 'Release computer session ' + sel + ' — hands control back to the agent');
          bar.appendChild(relBtn);
        }
        var stopBtn = P.el('button', 'comp-btn comp-stop', 'Stop session');
        stopBtn.setAttribute('aria-label', 'Stop computer session ' + sel);
        stopBtn.addEventListener('click', function () {
          P.api('/v2/computer/' + sel + '/control', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'set', state: 'done' }),
          }).then(function () { open(sel); })
            .catch(function () { detail.appendChild(P.el('div', 'comp-error', 'stop refused')); });
        });
        bar.appendChild(stopBtn);
        detail.appendChild(bar);

        (s.frames || []).forEach(function (f) {
          var row = P.el('div', 'frame kind-' + f.kind);
          row.appendChild(P.el('span', 'age', new Date(f.ts).toLocaleTimeString()));
          row.appendChild(P.el('span', 'tag exec', f.kind));
          row.appendChild(P.el('span', 'tool', f.summary || ''));
          // checkpoint annotation: frames carry an optional annotation field
          if (f.annotation) row.appendChild(P.el('div', 'checkpoint-note', f.annotation));
          detail.appendChild(row);
        });
      }).catch(function () { detail.textContent = 'unreadable'; });
    }

    function refreshList() {
      P.api('/v2/computer').then(function (d) {
        var arr = d.sessions || [];
        list.textContent = '';
        if (!arr.length) { list.appendChild(P.el('div', 'empty', 'no sessions')); return; }
        arr.forEach(function (s) {
          var row = P.el('div', 'botrow');
          row.appendChild(P.el('b', null, s.label || s.id));
          row.appendChild(P.el('span', 'role ' + (s.state || ''), s.state || '?'));
          row.appendChild(P.el('span', 'muted', (s.frames || []).length + ' frames'));
          row.appendChild(P.el('span', 'muted', s.bot || ''));
          row.addEventListener('click', function () { open(s.id); });
          list.appendChild(row);
        });
      }).catch(function () { list.textContent = 'unauthorized'; });
    }

    P.onAudit(function (e) {
      var p = e.payload || {};
      if (p.type === 'computer_session_created') refreshList();
      if (p.type === 'computer_frame' && sel && p.session === sel) { /* refetch frames */ open(sel); }
      if (p.type === 'computer_state_changed' && sel && p.session === sel) open(sel);
    });

    host.append(h, list, detail);
    refreshList();
  }
  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'computer', title: 'Computer', render: render });
})();
