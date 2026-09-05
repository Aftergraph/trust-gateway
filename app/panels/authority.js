'use strict';
// Authority panel (AIE surface in the TG console) — read-only view of AIE
// authority state (leases, missions, admissions, outcomes, evidence) through
// TG's /v2/authority proxy.
//
// Endpoints (src/gateway/mounts/132-authority-proxy.js):
//   GET  /v2/authority                       counts for all kinds
//   GET  /v2/authority/:kind                 items for kind (max 500)
//   POST /v2/authority/leases/:id/revoke     revoke a lease (H6)
//
// UI contract:
//   • kind tabs: leases / missions / admissions / outcomes / evidence
//   • leases show revocation flag + delegation depth + budget remaining
//   • counts summary at top; refresh + 15s auto-poll with cleanup
//   • H5 detail drawer: click row → revocation-historik, delegation tree, budget
//   • H6 revoke action: ACTIVE leases expose revoke-button (operator-only, fail-closed)
//   • fail-closed: 503 authority_disabled / 502 unreachable → inline notice
//
// XSS policy: textContent only, no innerHTML (same law as rooms.js).

(function () {
  const KINDS = ['leases', 'missions', 'admissions', 'outcomes', 'evidence'];
  const RENDER_CAP = 100;

  const api = window.TG && window.TG.api;
  const el = window.TG && window.TG.el;

  // H5: detail drawer — click lease/mission → vis revocation-historik,
  // delegation tree, budget. Missions: state-transitions + linked leases.
  function showDetail(kind, item, host) {
    // luk eksisterende drawer
    const old = host.querySelector('.auth-detail-drawer');
    if (old) { old.textContent = ''; old.remove(); }

    const drawer = el('div', 'auth-detail-drawer');
    drawer.append(el('h3', 'auth-detail-title', (kind || 'item') + ': ' + (item.id || '—')));

    if (kind === 'leases') {
      // Revocation-historik
      const revHist = Array.isArray(item.revocation_history) ? item.revocation_history : [];
      if (revHist.length) {
        drawer.append(el('div', 'auth-detail-section', 'Revocation history (' + revHist.length + ')'));
        const ul = el('ul', 'auth-rev-list');
        for (const r of revHist) {
          ul.append(el('li', null,
            (r.reason || 'no reason') + ' @ ' + (r.revoked_at || '?') + ' by ' + (r.actor || '?')));
        }
        drawer.append(ul);
      } else {
        drawer.append(el('div', 'muted', 'No revocation history'));
      }
      // Delegation tree (parent-child)
      const parent = item.parent_lease_id || item.delegated_from || null;
      const children = Array.isArray(item.child_leases) ? item.child_leases : [];
      drawer.append(el('div', 'auth-detail-section', 'Delegation'));
      if (parent) {
        drawer.append(el('div', 'auth-deleg-parent', 'Parent: ' + parent));
      } else {
        drawer.append(el('div', 'muted', 'Root lease (no parent)'));
      }
      if (children.length) {
        drawer.append(el('div', null, 'Children (' + children.length + '):'));
        const cl = el('ul', 'auth-deleg-children');
        for (const c of children) {
          cl.append(el('li', null, (c.id || '?') + ' depth:' + (c.depth ?? '?')));
        }
        drawer.append(cl);
      } else {
        drawer.append(el('div', 'muted', 'No child delegations'));
      }
      // Budget
      drawer.append(el('div', 'auth-detail-section', 'Budget'));
      drawer.append(el('div', null, 'Remaining: ' + (item.budget_remaining ?? '—') +
        ' / Total: ' + (item.budget_total ?? '—')));

      // H6: revoke-action for ACTIVE leases (operator handling direkte fra drawer).
      // Fail-closed: reason påkrævet; revoke-fejl vises ærligt inline; succes
      // genindlæser lease-listen så operatøren ser effekten med det samme.
      if (item.revoked !== true && item.id) {
        const revokeBar = el('div', 'auth-revoke-bar');
        const status = el('span', 'muted', '');
        const revokeBtn = el('button', 'btn no auth-revoke-btn', 'revoke lease');
        revokeBtn.addEventListener('click', () => {
          const reason = (prompt('Revoke reason (required):') || '').trim();
          if (!reason) {
            status.textContent = 'revoke cancelled: reason required';
            return;
          }
          revokeBtn.disabled = true;
          status.textContent = 'revoking…';
          api('/v2/authority/leases/' + encodeURIComponent(item.id) + '/revoke', {
            method: 'POST',
            body: JSON.stringify({ reason }),
          })
            .then((out) => {
              if (out && out.ok) {
                status.textContent = 'revoked — refreshing list';
                // trigger list refresh via refresh-knap i toolbar
                const toolbar = host.querySelector('.auth-toolbar .btn.ok');
                if (toolbar) toolbar.click();
              } else {
                const msg = (out && (out.error || out.reason)) || 'revoke failed';
                status.textContent = 'revoke fejl: ' + msg;
                revokeBtn.disabled = false;
              }
            })
            .catch((err) => {
              const msg = err && err.status ? 'HTTP ' + err.status : (err && err.message) || 'kunne ikke revoke';
              status.textContent = 'revoke fejl: ' + msg;
              revokeBtn.disabled = false;
            });
        });
        revokeBar.append(revokeBtn, status);
        drawer.append(revokeBar);
      }

    } else if (kind === 'missions') {
      // State transitions
      const transitions = Array.isArray(item.transitions) ? item.transitions : [];
      if (transitions.length) {
        drawer.append(el('div', 'auth-detail-section', 'State transitions'));
        const ul = el('ul', 'auth-transition-list');
        for (const t of transitions) {
          ul.append(el('li', null,
            (t.from || '?') + ' → ' + (t.to || '?') + ' @ ' + (t.at || '?')));
        }
        drawer.append(ul);
      } else {
        drawer.append(el('div', 'muted', 'No transition history'));
      }
      // Linked leases
      const leases = Array.isArray(item.linked_leases) ? item.linked_leases : [];
      if (leases.length) {
        drawer.append(el('div', 'auth-detail-section', 'Linked leases (' + leases.length + ')'));
        const ul = el('ul', 'auth-linked-leases');
        for (const l of leases) ul.append(el('li', null, l.id || l));
        drawer.append(ul);
      }
    } else {
      // Generic detail dump
      drawer.append(el('pre', 'auth-detail-raw', JSON.stringify(item, null, 2)));
    }

    const closeBtn = el('button', 'btn auth-detail-close', 'luk');
    closeBtn.addEventListener('click', () => { drawer.textContent = ''; drawer.remove(); });
    drawer.append(closeBtn);
    host.append(drawer);
  }

  function itemRow(kind, item) {
    const row = el('div', 'auth-row');
    row.style.cursor = 'pointer';
    row.title = 'klik for detaljer';
    row.addEventListener('click', () => {
      const list = row.closest('.auth-list');
      if (list) showDetail(kind, item, list.parentElement);
    });
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

  window.TG_PANELS = window.TG_PANELS || [];
  if (!window.TG_PANELS.some((p) => p.id === 'authority')) {
    window.TG_PANELS.push({ id: 'authority', title: 'Authority', render });
  }
})();
