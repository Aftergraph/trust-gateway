'use strict';
// H2/H3 E2E frontend: loader missions.js i mock-DOM, kalder render(),
// verificerer rigtig adfærd (ikke kun source-strings):
//   H2: mission-detail drawer viser verdict-badges fra H1 (ok/tampered/unsealed)
//   H3: proposal-row integrity-badges (tampered/unsealed/ok count)
// Fail-closed: manglende verdict = [unsealed], aldrig falsk "ok".
// XSS-loven: textContent only.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');

// --- Mock TG.api ---
const apiCalls = [];
function mockApi(urlPath, opts) {
  apiCalls.push({ path: urlPath, opts });
  // Proposals
  if (urlPath === '/v2/proposals') {
    return Promise.resolve({
      proposals: [
        { id: 'prop_1', objective: 'Byg feature X', state: 'submitted', mission_id: 'wrk_test' },
        { id: 'prop_2', objective: 'Draft mission', state: 'draft' },
      ],
    });
  }
  // Evidence med verdicts (WORKS G5-shape via H1 proxy)
  if (urlPath === '/v2/executions/wrk_test/evidence') {
    return Promise.resolve({
      bundle_id: 'evb_test',
      evidence_verdicts: { ev_1: 'ok', ev_2: 'tampered', ev_3: 'unsealed' },
      evidence: [],
    });
  }
  // WORKS execution med evidence
  if (urlPath === '/v2/executions/wrk_test') {
    return Promise.resolve({
      work: {
        state: 'SUCCEEDED',
        evidence: [
          { id: 'ev_1', type: 'build', result: 'pass' },
          { id: 'ev_2', type: 'test', result: 'fail' },
          { id: 'ev_3', type: 'scan', result: 'pass' },
        ],
      },
    });
  }
  if (urlPath === '/v1/audit/verify') {
    return Promise.resolve({ ok: true, length: 12 });
  }
  // Proposals actions (submit/approve/reject/leases)
  return Promise.resolve({ ok: true });
}

// --- Minimal DOM-mock (samme som authority-frontend-e2e) ---
function createMockDOM() {
  const allElements = [];
  function el(tag, className, text) {
    const e = {
      tagName: tag, className: className || '', textContent: text || '',
      children: [], style: {}, dataset: {}, title: '',
      parentElement: null, _listeners: {}, _removed: false,
      classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); } },
      append(...ch) { for (const c of ch) { if (c) { c.parentElement = this; this.children.push(c); } } },
      addEventListener(ev, fn) { this._listeners[ev] = fn; },
      remove() { this._removed = true; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (sel.startsWith('.') && String(cur.className).includes(sel.slice(1))) return cur;
          if (sel.startsWith('#') && cur.id === sel.slice(1)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
    };
    allElements.push(e);
    return e;
  }
  const body = el('body', '');
  body.contains = () => true;
  return { el, body, allElements };
}

function loadModule(dom, apiFn) {
  const sandbox = {
    window: { TG: { api: apiFn }, TG_PANELS: [] },
    document: { body: dom.body },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => {},
    clearInterval: () => {},
    Date,
    console,
  };
  sandbox.window.TG.el = dom.el;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'missions.js' });
  return sandbox;
}

async function renderMissions(dom) {
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 40));
  return { sb, host };
}

// --- Tests ---

test('H2: missions.js registrerer sig og render() henter proposals', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  assert.equal(sb.window.TG_PANELS[0].id, 'missions');
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(apiCalls.some((c) => c.path === '/v2/proposals'), 'henter proposals');
});

test('H3: proposal-row med mission_id henter integrity-verdicts (evidence)', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  await renderMissions(dom);
  const evidenceCalls = apiCalls.filter((c) => c.path.includes('/evidence'));
  assert.ok(evidenceCalls.length >= 1, 'evidence endpoint hentet for mission-row');
});

test('H3: integrity-badges — tampered vises som rød badge, aldrig skjult', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  await renderMissions(dom);
  // Find badges element med tampered-count
  const tamperedBadge = dom.allElements.find((e) =>
    e.className === 'badge badge-tampered' && /1 TAMPERED/.test(e.textContent));
  assert.ok(tamperedBadge, 'tampered-badge med count 1 vises');
  // unsealed-badge vises også (grå)
  const unsealedBadge = dom.allElements.find((e) =>
    e.className === 'badge badge-unsealed' && /1 unsealed/.test(e.textContent));
  assert.ok(unsealedBadge, 'unsealed-badge med count 1 vises');
});

test('H3: fail-closed — 0 tampered viser ikke alarm-badge', async () => {
  // Proposal uden mission_id (prop_2) skal IKKE have integrity-badges
  const dom = createMockDOM();
  await renderMissions(dom);
  const draftRow = dom.allElements.find((e) =>
    e.className === 'mission-row' && e.children.some((c) => c.textContent === 'prop_2'));
  assert.ok(draftRow, 'draft proposal-row findes');
  const draftBadges = dom.allElements.filter((e) => e.className === 'mission-integrity-badges');
  // Kun prop_1 (med mission_id) har badges-element
  assert.equal(draftBadges.length, 1, 'kun mission-korrelerede rows har badges-container');
});

test('H2: detail-drawer — click detail åbner drawer og viser verdict-badges', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  await renderMissions(dom);
  // Find mission-row for prop_1 og klik detail
  const row = dom.allElements.find((e) =>
    e.className === 'mission-row' && e.children.some((c) => c.textContent === 'prop_1'));
  assert.ok(row, 'prop_1 mission-row findes');
  // detail-knap ligger i mission-actions (nested)
  const detailBtn = dom.allElements.find((e) => e.className === 'btn mission-detail');
  assert.ok(detailBtn, 'detail-knap i row');
  detailBtn._listeners.click();
  await new Promise((r) => setTimeout(r, 30));

  // Drawer skal findes
  const drawer = dom.allElements.find((e) => e.className === 'mission-detail-drawer');
  assert.ok(drawer, 'detail-drawer åbnet');

  // Verdict-badges: [hash ok] for ev_1 (verdict=ok), [TAMPERED] for ev_2
  const okBadge = dom.allElements.find((e) => e.className.includes('ev-verdict-ok'));
  assert.ok(okBadge, '[hash ok] badge vises for verdict ok');
  const tamperedBadge = dom.allElements.find((e) => e.className.includes('ev-verdict-tampered'));
  assert.ok(tamperedBadge, '[TAMPERED] badge vises for verdict tampered');
});

test('H2: fail-closed — ev uden verdict og uden hash vises som [unsealed]', async () => {
  // Tilføj evidence-item uden hash og verdict
  const customApi = (urlPath, opts) => {
    apiCalls.push({ path: urlPath, opts });
    if (urlPath === '/v2/proposals') {
      return Promise.resolve({ proposals: [
        { id: 'prop_1', objective: 'X', state: 'submitted', mission_id: 'wrk_nohash' },
      ] });
    }
    if (urlPath === '/v2/executions/wrk_nohash') {
      return Promise.resolve({ work: { state: 'RUNNING', evidence: [
        { id: 'ev_x', type: 'build', result: 'pass' },  // ingen verdict, ingen hash
      ] } });
    }
    if (urlPath === '/v2/executions/wrk_nohash/evidence') {
      return Promise.resolve({ evidence_verdicts: {} });  // tomme verdicts
    }
    if (urlPath === '/v1/audit/verify') return Promise.resolve({ ok: true, length: 3 });
    return Promise.resolve({ ok: true });
  };
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, customApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 30));

  const row = dom.allElements.find((e) =>
    e.className === 'mission-row' && e.children.some((c) => c.textContent === 'prop_1'));
  const detailBtn = dom.allElements.find((e) => e.className === 'btn mission-detail');
  detailBtn._listeners.click();
  await new Promise((r) => setTimeout(r, 30));

  // ev_x uden verdict og uden hash → [unsealed]
  const unsealed = dom.allElements.find((e) => e.className.includes('ev-hash-unsealed'));
  assert.ok(unsealed, '[unsealed] vises for ev uden verdict+hash');
  // Ingen falsk [hash ok]
  const okBadge = dom.allElements.find((e) => e.className.includes('ev-verdict-ok'));
  assert.ok(!okBadge, 'ingen falsk [hash ok] uden verdict');
});

test('H3: approve/reject knapper vises kun for submitted proposals', async () => {
  const dom = createMockDOM();
  await renderMissions(dom);
  const rows = dom.allElements.filter((e) => e.className === 'mission-row');
  const prop1 = rows.find((r) => r.children.some((c) => c.textContent === 'prop_1'));
  const prop2 = rows.find((r) => r.children.some((c) => c.textContent === 'prop_2'));
  // prop_1 (submitted) har approve+reject
  const p1Btns = prop1.children.find((c) => c.className === 'mission-actions');
  assert.ok(p1Btns.children.some((c) => c.className === 'btn ok mission-approve'), 'approve-knap');
  assert.ok(p1Btns.children.some((c) => c.className === 'btn no mission-reject'), 'reject-knap');
  // prop_2 (draft) har submit men ikke approve/reject
  const p2Btns = prop2.children.find((c) => c.className === 'mission-actions');
  assert.ok(p2Btns.children.some((c) => c.className === 'btn mission-submit'), 'submit-knap');
  assert.ok(!p2Btns.children.some((c) => c.className.includes('mission-approve')), 'ingen approve for draft');
});

test('XSS-loven: ingen innerHTML i missions.js', () => {
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven: ingen innerHTML');
});
