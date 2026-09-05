'use strict';
// Authority panel (AIE surface in the TG console) — read-only view of AIE
// authority state (leases, missions, admissions, outcomes, evidence) through
// TG's /v2/authority proxy.
//
// Endpoints (src/gateway/mounts/132-authority-proxy.js):
//   GET /v2/authority                  counts for all kinds
//   GET /v2/authority/:kind            items for kind (max 500)
//
// UI contract:
//   • kind tabs: leases / missions / admissions / outcomes / evidence
//   • leases show revocation flag + delegation depth + budget remaining
//   • counts summary at top; refresh + 15s auto-poll with cleanup
//   • fail-closed: 503 authority_disabled / 502 unreachable → inline notice
//
// XSS policy: textContent only, no innerHTML (same law as rooms.js).

(function () {
  const KINDS = ['leases', 'missions', 'admissions', 'outcomes', 'evidence'];
  const RENDER_CAP = 100;

  const api = window.TG && window.TG.api;
  const el = window.TG && window.TG.el;

  function itemRow(kind, item) {
    const row = el('div', 'auth-row');
    row.append(el('span', 'auth-id mono', (item.id || '—').slice(0, 14)));
    if (kind === 'leases') {
      const revoked = item.revoked === true;
      row.append(el('span', 'auth-badge ' + (revoked ? 'auth-revoked' : 'auth-active'),
        revoked ? 'REVOKED' : 'ACTIVE'));
      row.append(el('span', 'muted', 'depth:' + (item.depth ?? 0)));
      row.append(el('span', 'muted', 'budget:' + (item.budget_remaining ?? '—')));
    } else if (kind === 'missions') {
      row.append(el('span', 'auth-badge ' + (item.state === 'active' ? 'auth-active' : 'auth-revoked'),
        item.state || 'UNKNOWN'));
    } else {
      row.append(el('span', 'muted', JSON.stringify(item).slice(0, 80)));
    }
    return row;
  }

  function render(hostEl) {
    const wrap = el('div', 'authority-wrap');

    const toolbar = el('div', 'auth-toolbar');
    const refreshBtn = el('button', 'btn ok', 'refresh');
    const status = el('span', 'muted', '');
    toolbar.append(refreshBtn, status);

    const tabs = el('div', 'auth-tabs');
    const tabsBtns = {};
    for (const k of KINDS) {
      const b = el('button', 'tab-btn', k);
      b.dataset.kind = k;
      tabs.append(b);
      tabsBtns[k] = b;
    }

    const summary = el('div', 'auth-summary muted', '');
    const list = el('div', 'auth-list');

    let active = true;
    let pollTimer = null;
    let currentKind = 'leases';

    function loadCounts() {
      api('/v2/authority')
        .then((d) => {
          if (!active) return;
          if (d && d.counts) {
            summary.textContent = KINDS.map((k) => k + ':' + (d.counts[k] ?? 0)).join(' · ');
          }
        })
        .catch(() => { /* counts are best-effort */ });
    }

    function loadItems() {
      if (!active) return;
      status.textContent = '…';
      api('/v2/authority/' + encodeURIComponent(currentKind))
        .then((d) => {
          if (!active) return;
          status.textContent = (d && d.count != null ? d.count : '?') + ' items';
          list.textContent = '';
          const items = (d && Array.isArray(d.items)) ? d.items : [];
          if (!items.length) {
            list.append(el('div', 'muted', 'no ' + currentKind + ' yet'));
            return;
          }
          for (const item of items.slice(0, RENDER_CAP)) list.append(itemRow(currentKind, item));
        })
        .catch((err) => {
          if (!active) return;
          status.textContent = '';
          list.textContent = '';
          const msg = err && err.status === 503 ? 'AIE authority bridge not configured (authority_disabled)'
            : err && err.status === 502 ? 'AIE authority bridge unreachable'
            : err && err.status === 403 ? 'operator role required'
            : 'load failed ' + (err && err.status ? '(' + err.status + ')' : '');
          list.append(el('div', 'muted', msg));
        });
    }

    function selectKind(kind) {
      currentKind = kind;
      for (const b of tabs.querySelectorAll('.tab-btn')) b.classList.remove('active');
      tabsBtns[kind].classList.add('active');
      loadItems();
    }

    for (const k of KINDS) tabsBtns[k].addEventListener('click', () => selectKind(k));
    refreshBtn.addEventListener('click', () => { loadCounts(); loadItems(); });

    pollTimer = setInterval(() => { loadCounts(); loadItems(); }, 15000);

    const observer = new MutationObserver(() => {
      if (!document.body.contains(wrap)) {
        active = false;
        if (pollTimer) clearInterval(pollTimer);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    wrap.append(toolbar, tabs, summary, list);
    hostEl.append(wrap);
    tabsBtns[currentKind].classList.add('active');
    loadCounts();
    loadItems();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'authority', title: 'Authority', render });
})();
