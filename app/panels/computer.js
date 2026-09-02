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
        (s.frames || []).forEach(function (f) {
          var row = P.el('div', 'frame kind-' + f.kind);
          row.appendChild(P.el('span', 'age', new Date(f.ts).toLocaleTimeString()));
          row.appendChild(P.el('span', 'tag exec', f.kind));
          row.appendChild(P.el('span', 'tool', f.summary || ''));
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
