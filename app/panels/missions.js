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
    if (p.mission_id) row.append(el('span', 'mission-corr', p.mission_id));
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
    row.append(actions);
    return row;
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