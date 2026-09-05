'use strict';
// E3 — Missions panel: chat-oprettede MissionProposals, synlige og godkendbare.
//
// Endpoints (src/gateway/mounts/23-missions.js):
//   GET  /v2/proposals            liste (?status=)
//   POST /v2/proposals/:id/submit  draft -> submitted
//   POST /v2/proposals/:id/approve {approver} -> mission-correlation stamped
//   POST /v2/proposals/:id/reject  {reason}
//
// XSS-loven: textContent only — ingen innerHTML (test-enforced).
// Operator-flow: approve/reject-knapper kun for state submitted.

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;

  function stateClass(state) {
    return 'mission-state-' + String(state || 'draft').replace(/[^a-z]/gi, '');
  }

  function proposalRow(p, host, reload) {
    const row = el('div', 'mission-row');
    row.append(el('span', 'mission-id', p.id || ''));
    row.append(el('span', 'mission-obj', p.objective || ''));
    row.append(el('span', 'mission-state ' + stateClass(p.state), p.state || 'draft'));
    if (p.mission_id) {
      row.append(el('span', 'mission-corr', p.mission_id));
      // E4: lease-visning — klik henter AIE-leases for missionen (operator)
      const leaseBtn = el('button', 'btn mission-leases', 'leases');
      leaseBtn.title = 'vis AIE-leases for missionen';
      leaseBtn.addEventListener('click', () => {
        api('/v2/proposals/' + encodeURIComponent(p.id) + '/leases')
          .then((out) => {
            const leases = (out && out.leases) || [];
            const info = out && out.unavailable
              ? 'AIE utilgængelig'
              : (leases.length ? leases.map((l) => l.id || l.lease_id || '?').join(', ') : 'ingen leases');
            row.append(el('span', 'mission-leases', info));
          })
          .catch(() => { /* fail-closed i UI */ });
      });
    }
    const actions = el('span', 'mission-actions');
    if (p.state === 'draft') {
      const submitBtn = el('button', 'btn mission-submit', 'submit');
      submitBtn.addEventListener('click', () => {
        api('/v2/proposals/' + encodeURIComponent(p.id) + '/submit', { method: 'POST', body: JSON.stringify({}) })
          .then(() => reload()).catch(() => { /* fail-closed i UI */ });
      });
      actions.append(submitBtn);
    }
    if (p.state === 'submitted') {
      const approveBtn = el('button', 'btn ok mission-approve', 'approve');
      approveBtn.addEventListener('click', () => {
        api('/v2/proposals/' + encodeURIComponent(p.id) + '/approve', {
          method: 'POST', body: JSON.stringify({ approver: 'op' }) })
          .then(() => reload()).catch(() => { /* fail-closed */ });
      });
      const rejectBtn = el('button', 'btn no mission-reject', 'reject');
      rejectBtn.addEventListener('click', () => {
        api('/v2/proposals/' + encodeURIComponent(p.id) + '/reject', {
          method: 'POST', body: JSON.stringify({ reason: 'rejected from console' }) })
          .then(() => reload()).catch(() => { /* fail-closed */ });
      });
      actions.append(approveBtn, rejectBtn);
    }
    if (p.mission_id && typeof leaseBtn !== 'undefined') actions.append(leaseBtn);
    // F1: detail-knap — aebner mission-detail drawer (WORKS + evidence + leases)
    const detailBtn = el('button', 'btn mission-detail', 'detail');
    detailBtn.title = 'vis mission-detaljer';
    detailBtn.addEventListener('click', () => showMissionDetail(p, host, reload));
    actions.append(detailBtn);
    row.append(actions);
    return row;
  }

  // F1: mission-detail drawer — WORKS-execution + evidence + leases i ét view.
  // Fail-closed: WORKS/evidence utilgaengelig vises som 'ikke tilgaengelig' —
  // aldrig syntetiske data. XSS-loven: textContent-only.
  function showMissionDetail(p, host, reload) {
    // luk eksisterende drawer
    const old = host.querySelector ? null : null;
    for (const c of (host.children || [])) {
      if (String(c.className || '').includes('mission-detail-drawer')) { c.textContent = ''; c._removed = true; }
    }
    // fjern markerede drawers
    if (host.children) host.children = host.children.filter ? host.children.filter((c) => !c._removed) : host.children;

    const drawer = el('div', 'mission-detail-drawer');
    drawer.append(el('h3', 'mission-detail-title', 'Mission: ' + (p.objective || p.id)));
    drawer.append(el('div', 'mission-detail-state', 'status: ' + (p.state || 'draft')));
    drawer.append(el('div', 'mission-detail-id', 'proposal: ' + (p.id || '') + (p.mission_id ? ' | mission: ' + p.mission_id : '')));

    // success criteria
    if (Array.isArray(p.success_criteria) && p.success_criteria.length) {
      const ul = el('ul', 'mission-detail-criteria');
      for (const c of p.success_criteria) ul.append(el('li', null, String(c)));
      drawer.append(ul);
    }

    const closeBtn = el('button', 'btn mission-detail-close', 'luk');
    closeBtn.addEventListener('click', () => {
      drawer.textContent = '';
      if (host.children && host.children.filter) host.children = host.children.filter((c) => c !== drawer);
    });
    drawer.append(closeBtn);

    // WORKS-execution + evidence (kun hvis correlation findes)
    if (p.mission_id) {
      const execBox = el('div', 'mission-detail-exec');
      execBox.append(el('div', 'muted', 'henter WORKS-execution…'));
      drawer.append(execBox);
      api('/v2/executions/' + encodeURIComponent(p.mission_id))
        .then((out) => {
          execBox.textContent = '';
          const w = (out && out.work) || out || {};
          execBox.append(el('div', 'mission-exec-state', 'WORKS: ' + (w.state || w.status || 'ukendt')));
          const evs = Array.isArray(w.evidence) ? w.evidence : [];
          if (evs.length) {
            const evList = el('div', 'mission-detail-evidence');
            evList.append(el('b', null, 'evidence:'));
            for (const ev of evs) {
              evList.append(el('div', 'mission-evidence-item', ev.id || ev.hash || JSON.stringify(ev).slice(0, 60)));
            }
            execBox.append(evList);
          } else {
            execBox.append(el('div', 'muted', 'ingen evidence endnu'));
          }
        })
        .catch(() => {
          execBox.textContent = '';
          execBox.append(el('div', 'muted', 'WORKS utilgaengelig'));
        });
    }

    host.append(drawer);
  }

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'missions-panel');
    const list = el('div', 'mission-list');
    list.append(el('div', 'empty', 'indlæser…'));
    wrap.append(list);
    hostEl.append(wrap);

    const reload = () => {
      api('/v2/proposals')
        .then((out) => {
          list.textContent = '';
          const proposals = (out && out.proposals) || [];
          if (!proposals.length) { list.append(el('div', 'empty', 'ingen missioner endnu')); return; }
          for (const p of proposals) list.append(proposalRow(p, hostEl, reload));
        })
        .catch(() => { list.textContent = ''; list.append(el('div', 'empty', 'kunne ikke hente missioner')); });
    };
    reload();
  }

  if (!window.TG_PANELS.some((p) => p.id === 'missions')) {
    window.TG_PANELS.push({ id: 'missions', title: 'Missions', render });
  }
})();