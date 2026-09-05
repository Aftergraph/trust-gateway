'use strict';
// Executions panel (WORKS surface in the TG console) — read-only view of the
// WORKS control plane, surfaced through TG's /v2/executions proxy.
//
// Endpoints (src/gateway/mounts/131-works-proxy.js):
//   GET /v2/executions                    list works (limit 100)
//   GET /v2/executions/:workId            single work: graph, attempts, evidence
//   GET /v2/executions/:workId/evidence   evidence records
//
// UI contract:
//   • work list with state badges (CREATED / QUEUED / RUNNING / SUCCEEDED /
//     FAILED / CANCELLED), newest first, render capped at 100 rows
//   • click a work row → detail view: objective, state, attempts, artifacts,
//     evidence records (collapsed by default)
//   • refresh button + auto-poll every 15s while the panel is active
//   • fail-closed: 503 works_disabled / 502 unreachable → an inline notice,
//     never synthetic data
//
// XSS policy: textContent only, no innerHTML (same law as rooms.js).

(function () {
  const RENDER_CAP = 100;

  const api = window.TG && window.TG.api;
  const el = window.TG && window.TG.el;

  const STATE_CLASS = {
    CREATED: 'st-created',
    QUEUED: 'st-queued',
    RUNNING: 'st-running',
    SUCCEEDED: 'st-succeeded',
    FAILED: 'st-failed',
    CANCELLED: 'st-cancelled',
    WAITING_HUMAN: 'st-waiting',
    SUSPENDED: 'st-suspended',
  };

  function stateBadge(state) {
    const cls = STATE_CLASS[state] || 'st-created';
    return el('span', 'exec-state-badge ' + cls, state || 'UNKNOWN');
  }

  function shortId(id) {
    return typeof id === 'string' && id.length > 14 ? id.slice(0, 14) + '…' : (id || '—');
  }

  function workRow(work, onOpen) {
    const row = el('div', 'exec-row');
    row.append(stateBadge(work.state));
    const id = el('span', 'exec-id mono', shortId(work.id));
    id.title = work.id || '';
    row.append(id);
    const objective = work.objective && (work.objective.text || work.objective.title || work.objective.description);
    row.append(el('span', 'exec-objective', String(objective || '—').slice(0, 90)));
    const created = work.created_at ? new Date(work.created_at).toLocaleString() : '—';
    row.append(el('span', 'exec-created muted', created));
    if (onOpen) {
      const openBtn = el('button', 'btn exec-open-btn', 'open');
      openBtn.addEventListener('click', () => onOpen(work));
      row.append(openBtn);
    }
    return row;
  }

  function renderDetail(work, container, onBack) {
    container.textContent = '';
    const head = el('div', 'exec-detail-head');
    head.append(stateBadge(work.state));
    head.append(el('span', 'exec-id mono', work.id || '—'));
    const back = el('button', 'btn', '← back');
    back.addEventListener('click', onBack);
    head.append(back);
    container.append(head);

    const objective = work.objective && (work.objective.text || work.objective.title || work.objective.description);
    container.append(el('div', 'exec-objective-full', String(objective || '—')));

    // Graph nodes (if present)
    const graph = work.graph && Array.isArray(work.graph.nodes) ? work.graph.nodes : [];
    if (graph.length) {
      container.append(el('h4', null, 'Graph nodes'));
      const nodes = el('div', 'exec-nodes');
      for (const n of graph) {
        nodes.append(el('div', 'exec-node', (n.id || '?') + ' — ' + (n.kind || n.type || 'node')));
      }
      container.append(nodes);
    }

    // Attempts
    const attempts = Array.isArray(work.attempts) ? work.attempts : [];
    container.append(el('h4', null, 'Attempts (' + attempts.length + ')'));
    if (!attempts.length) container.append(el('div', 'muted', 'no attempts yet'));
    for (const a of attempts.slice(0, 20)) {
      const aRow = el('div', 'exec-attempt');
      aRow.append(el('span', 'mono', shortId(a.id || a.attempt_id)));
      aRow.append(el('span', 'muted', a.state || a.status || ''));
      container.append(aRow);
    }

    // Evidence
    const evidence = Array.isArray(work.evidence) ? work.evidence : [];
    container.append(el('h4', null, 'Evidence (' + evidence.length + ')'));
    if (!evidence.length) container.append(el('div', 'muted', 'no evidence records'));
    for (const ev of evidence.slice(0, 20)) {
      const evRow = el('div', 'exec-evidence');
      evRow.append(el('span', 'mono', ev.kind || ev.type || 'evidence'));
      evRow.append(el('span', 'muted', ev.summary || ev.id || ''));
      container.append(evRow);
    }
  }

  function render(hostEl) {
    const wrap = el('div', 'executions-wrap');

    const form = el('div', 'exec-toolbar');
    const refreshBtn = el('button', 'btn ok', 'refresh');
    const status = el('span', 'muted', '');
    form.append(refreshBtn, status);

    const list = el('div', 'exec-list');
    const detail = el('div', 'exec-detail');
    detail.style.display = 'none';

    let active = true;
    let pollTimer = null;

    function showList() {
      detail.style.display = 'none';
      list.style.display = '';
      loadList();
    }

    function loadList() {
      if (!active) return;
      status.textContent = '…';
      api('/v2/executions')
        .then((d) => {
          if (!active) return;
          status.textContent = (d && d.count != null ? d.count : '?') + ' works';
          list.textContent = '';
          const works = (d && Array.isArray(d.works)) ? d.works : [];
          if (!works.length) {
            list.append(el('div', 'muted', 'no works yet'));
            return;
          }
          for (const w of works.slice(0, RENDER_CAP)) {
            list.append(workRow(w, (work) => {
              detail.style.display = '';
              list.style.display = 'none';
              api('/v2/executions/' + encodeURIComponent(work.id))
                .then((detailData) => {
                  const w2 = (detailData && detailData.work) || work;
                  renderDetail(w2, detail, showList);
                })
                .catch(() => renderDetail(work, detail, showList));
            }));
          }
        })
        .catch((err) => {
          if (!active) return;
          status.textContent = '';
          list.textContent = '';
          const msg = err && err.status === 503 ? 'WORKS control plane not configured (works_disabled)'
            : err && err.status === 502 ? 'WORKS control plane unreachable'
            : 'load failed ' + (err && err.status ? '(' + err.status + ')' : '');
          list.append(el('div', 'muted', msg));
        });
    }

    refreshBtn.addEventListener('click', showList);

    // Auto-poll every 15s while this panel is mounted (lightweight: one GET)
    pollTimer = setInterval(loadList, 15000);

    // Stop polling when the panel is unmounted (hostEl removed from DOM)
    const observer = new MutationObserver(() => {
      if (!document.body.contains(wrap)) {
        active = false;
        if (pollTimer) clearInterval(pollTimer);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    wrap.append(form, list, detail);
    hostEl.append(wrap);
    loadList();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'executions', title: 'Executions', render });
})();
