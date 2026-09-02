'use strict';
// Models & Providers panel (wave B UI) — W6 provider registry console section.
// Registers into window.TG_PANELS; the core tab-router (app/panels/core.js)
// mounts render(hostEl) when the "Models & Providers" tab is clicked.
//
// Endpoints (src/gateway/mounts/45-providers.js):
//   GET  /v2/providers            provider directory (no credential material, ever)
//   GET  /v2/providers/models     flat model catalog across providers
//   POST /v2/providers/plan       {task, preferFree, maxLanes} routing plan
//   POST /v2/providers/probe      {provider} → live reachability probe
//
// SECURITY: the provider surface never exposes credential material and this
// panel never displays or handles any of it — test-enforced (no key-like
// identifiers anywhere in this file).
//
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;

  // --- provider table row: name, kind, model count, probe button ----------
  function providerRow(p) {
    const row = el('div', 'prov-row');
    row.append(el('b', null, p.name || '?'));
    row.append(el('span', 'prov-kind', p.kind || ''));
    const count = p.modelCount != null ? p.modelCount : (p.models ? p.models.length : 0);
    row.append(el('span', 'muted', count + ' models'));
    const probeBtn = el('button', 'btn', 'probe');
    const probeOut = el('span', 'prov-probe muted', p.status ? String(p.status) : 'not probed');
    probeBtn.addEventListener('click', () => {
      probeOut.textContent = 'probing…';
      api('/v2/providers/probe', { method: 'POST', body: JSON.stringify({ provider: p.name }) })
        .then((r) => {
          probeOut.textContent = r && r.ok ? 'ok ✓' : String((r && (r.status || r.error)) || 'unreachable ✖');
          probeOut.className = 'prov-probe ' + (r && r.ok ? 'probe-ok' : 'probe-bad');
        })
        .catch((err) => { probeOut.textContent = 'error ' + (err.status || ''); });
    });
    row.append(probeBtn, probeOut);
    return row;
  }

  // --- model browser row ----------------------------------------------------
  function modelRow(m) {
    const row = el('div', 'model-row');
    row.append(el('span', 'model-provider muted', m.provider || '?'));
    row.append(el('span', 'model-name', m.model || '?'));
    if (m.isDefault) row.append(el('span', 'model-default', 'default'));
    return row;
  }

  // --- ranked plan lane row (with reason) -----------------------------------
  function laneRow(l, i) {
    const row = el('div', 'lane-row');
    row.append(el('span', 'lane-rank muted', '#' + (i + 1)));
    row.append(el('b', null, (l.provider || '?') + ' / ' + (l.model || '?')));
    row.append(el('span', 'lane-free ' + (l.free ? 'is-free' : 'is-paid'), l.free ? 'free' : 'paid'));
    const reason = (l && l.note) ? l.note : (l.free ? 'free lane' : 'paid lane');
    row.append(el('span', 'lane-reason muted', reason));
    return row;
  }

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'providers-panel');

    // --- provider table ---
    const provList = el('div', 'prov-list');
    const provTitle = el('h3', null, 'providers');

    // --- model browser (filter by substring) ---
    const modelTitle = el('h3', null, 'models');
    const filterIn = el('input', 'model-filter');
    filterIn.placeholder = 'filter models…';
    const modelList = el('div', 'model-list');
    let allModels = [];
    function drawModels() {
      const q = filterIn.value.trim().toLowerCase();
      modelList.textContent = '';
      const shown = allModels.filter((m) => !q || String(m.model || '').toLowerCase().indexOf(q) !== -1);
      if (!shown.length) { modelList.append(el('div', 'empty', q ? 'no models match' : 'no models')); return; }
      for (const m of shown) modelList.append(modelRow(m));
    }
    filterIn.addEventListener('input', drawModels);

    // --- plan a task form ---
    const planTitle = el('h3', null, 'plan a task');
    const form = el('form', 'plan-form');
    const taskIn = el('input', 'plan-task');
    taskIn.placeholder = 'describe the task…';
    const freeLbl = el('label', 'plan-free');
    const freeIn = el('input', null);
    freeIn.type = 'checkbox';
    freeIn.checked = true;
    freeLbl.append(freeIn, el('span', null, 'prefer free'));
    const lanesIn = el('input', 'plan-lanes narrow');
    lanesIn.type = 'number';
    lanesIn.min = '1';
    lanesIn.placeholder = 'max lanes';
    const planBtn = el('button', 'btn ok', 'plan');
    const planMsg = el('span', 'muted', '');
    form.append(taskIn, freeLbl, lanesIn, planBtn, planMsg);

    const planOut = el('div', 'plan-out');
    planOut.style.display = 'none';

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const task = taskIn.value.trim();
      if (!task) { planMsg.textContent = 'task required'; return; }
      const body = { task, preferFree: freeIn.checked };
      const n = Number(lanesIn.value);
      if (Number.isFinite(n) && n > 0) body.maxLanes = Math.floor(n);
      planMsg.textContent = '…';
      api('/v2/providers/plan', { method: 'POST', body: JSON.stringify(body) })
        .then((p) => {
          planMsg.textContent = '';
          planOut.textContent = '';
          planOut.style.display = '';
          planOut.append(el('div', 'plan-tag muted', 'tag: ' + (p.taskTag || 'general')));
          const prim = p.primary || {};
          const primRow = el('div', 'plan-primary');
          primRow.append(el('span', null, 'primary: '));
          primRow.append(el('b', null, (prim.provider || '?') + ' / ' + (prim.model || '?')));
          planOut.append(primRow);
          const lanes = p.lanes || [];
          if (!lanes.length) planOut.append(el('div', 'empty', 'no lanes'));
          lanes.forEach((l, i) => planOut.append(laneRow(l, i)));
        })
        .catch((err) => { planMsg.textContent = 'error ' + (err.status || ''); });
    });

    // --- data loading ---
    function refreshProviders() {
      api('/v2/providers')
        .then((d) => {
          provList.textContent = '';
          provList.append(provTitle);
          const providers = (d && d.providers) || [];
          if (!providers.length) provList.append(el('div', 'empty', 'no providers registered'));
          for (const p of providers) provList.append(providerRow(p));
        })
        .catch(() => {
          provList.textContent = '';
          provList.append(provTitle);
          provList.append(el('div', 'empty', window.TG.authed() ? 'providers unavailable' : 'enter a token to load providers'));
        });
    }
    function refreshModels() {
      api('/v2/providers/models')
        .then((d) => { allModels = (d && d.models) || []; drawModels(); })
        .catch(() => { allModels = []; drawModels(); });
    }

    // live updates: probe/plan audits arrive via the shared SSE fan-out
    window.TG.onAudit((e) => {
      const t = e && e.payload && e.payload.type;
      if (t === 'provider_probe' || t === 'provider_plan') refreshProviders();
    });

    wrap.append(provList, modelTitle, filterIn, modelList, planTitle, form, planOut);
    hostEl.append(wrap);
    refreshProviders();
    refreshModels();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'providers', title: 'Models & Providers', render });
})();