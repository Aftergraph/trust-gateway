'use strict';
// D5 UI — Provider Observability panel.
// Registers into window.TG_PANELS; id 'providers-live'.
// XSS policy: textContent only — no innerHTML anywhere.

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return;

  const api = window.TG.api;
  const el = window.TG.el;

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'providers-live-panel');

    const head = el('div', 'pl-head');
    head.append(el('h3', null, 'Provider Observability'));
    head.append(el('span', 'muted', 'live connectivity status'));
    wrap.append(head);

    const controls = el('div', 'pl-controls');
    const refreshBtn = el('button', 'btn ok', 'refresh');
    const status = el('span', 'pl-status muted', '');
    controls.append(refreshBtn, status);
    wrap.append(controls);

    const tableWrap = el('div', 'pl-table-wrap');
    const table = el('table', 'pl-table');
    const thead = el('thead');
    const headerRow = el('tr');
    ['Name', 'Status', 'Latency', 'Detail'].forEach((h) => {
      headerRow.append(el('th', null, h));
    });
    thead.append(headerRow);
    table.append(thead);

    const tbody = el('tbody', 'pl-body');
    table.append(tbody);
    tableWrap.append(table);
    wrap.append(tableWrap);

    function load() {
      status.textContent = 'loading…';
      tbody.textContent = '';
      api('/v2/providers/live')
        .then((d) => {
          status.textContent = 'updated ' + new Date().toLocaleTimeString();
          const rows = d && Array.isArray(d.providers) ? d.providers : [];
          rows.forEach((p) => {
            const tr = el('tr');
            tr.append(el('td', null, p.name));
            const badge = el('td');
            const badgeSpan = el('span', 'badge ' + (p.ok ? 'ok' : 'err'), p.ok ? 'OK' : 'FAIL');
            badge.append(badgeSpan);
            tr.append(badge);
            tr.append(el('td', null, p.ms != null ? p.ms + 'ms' : '—'));
            tr.append(el('td', null, p.detail || ''));
            tbody.append(tr);
          });
        })
        .catch((err) => {
          status.textContent = 'error ' + (err.status || err.message || '');
        });
    }

    refreshBtn.addEventListener('click', load);
    load();

    hostEl.append(wrap);
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'providers-live', title: 'Providers Live', render });
})();
