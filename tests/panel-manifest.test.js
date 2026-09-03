'use strict';
// §19.3/G7 — the spec-named validation harness (was a BACKEND GAP).
// Loads app/compose.js in a vm sandbox and asserts: every shipped manifest
// validates; invalid manifests reject with useful errors; the composition
// engine honors §5.2 MUST rules; omittedBecause values are always from the
// canonical set (any other value is an engine bug — §4.6 rule 28).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCompose() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'compose.js'), 'utf8');
  const win = {};
  const ctx = vm.createContext({ window: win, localStorage: { getItem: () => null }, location: { search: '' }, navigator: {}, innerWidth: 1200 });
  new vm.Script(src, { filename: 'compose.js' }).runInContext(ctx);
  return win.TG_COMPOSE;
}

const C = loadCompose();

test('engine exports the kernel vocabulary exactly (§5.1/00-KERNEL)', () => {
  assert.deepEqual([...C.SURFACES], ['Feed', 'Board', 'Graph', 'Detail', 'Composer', 'Diff', 'EvidencePanel', 'Queue', 'Timeline', 'Terminal', 'Modal/Drawer']);
  assert.deepEqual([...C.INTENTS], ['explore', 'compose', 'execute', 'approve', 'review', 'monitor', 'admin']);
  assert.deepEqual([...C.RISKS], ['read', 'write', 'destructive', 'secret']);
  assert.deepEqual([...C.DEVICES], ['desktop', 'mobile', 'terminal']);
  assert.deepEqual([...C.KERNEL_DOMAINS], ['NOW', 'CHAT', 'WORK', 'AGENTS', 'BRAIN', 'OUTPUT', 'CONTROL', 'CONNECT', 'SYSTEM']);
  assert.deepEqual([...C.OMIT_REASONS], ['risk', 'capability', 'intent', 'device']);
});

test('G7: every shipped manifest passes validation', () => {
  for (const m of C.MANIFESTS) {
    const v = C.validateManifest(m);
    assert.ok(v.ok, 'manifest ' + m.id + ' invalid: ' + v.errors.join('; '));
  }
});

test('G7: invalid manifests reject at validation with useful errors', () => {
  const cases = [
    [{ id: 'Bad-Id' }, /id:/],
    [{ id: 'ok', title: '', version: '1.0' }, /title:|version:/],
    [{ id: 'ok', title: 't', version: '1.0.0', domains: ['BOGUS'] }, /unknown domain/],
    [{ id: 'ok', title: 't', version: '1.0.0', domains: ['NOW'], surfaces: ['Dashboard'] }, /not in kernel vocabulary/],
    [{ id: 'ok', title: 't', version: '1.0.0', domains: ['NOW'], surfaces: [], surfacesUsed: [], requiredCapabilities: [], entry: '../evil.js', lazy: false, hidden: false, required: false }, /entry:/],
    [{ id: 'ok', title: 't', version: '1.0.0', domains: ['NOW'], surfaces: [], surfacesUsed: [], requiredCapabilities: [], entry: 'p.js', lazy: 'yes', hidden: false, required: false }, /lazy:/],
    [{ id: 'ok', title: 't', version: '1.0.0', domains: ['NOW'], surfaces: [], surfacesUsed: [], requiredCapabilities: [], entry: 'p.js', lazy: false, hidden: false, required: false, keybindings: [{ key: 'x', context: 'bogus', action: 'a' }] }, /keybindings:/],
  ];
  for (const [m, re] of cases) {
    const v = C.validateManifest(m);
    assert.equal(v.ok, false, 'should reject: ' + JSON.stringify(m));
    assert.ok(v.errors.some((e) => re.test(e)), 'error for ' + JSON.stringify(m) + ' expected ' + re + ' got ' + v.errors.join('; '));
  }
});

test('§5.2 rule 1: destructive risk → Modal/Drawer gate at position 0, background dimmed, no inline Composer/Queue', () => {
  const plan = C.composePlan({ domain: 'output', risk: 'destructive', capabilities: ['*'] });
  assert.equal(plan.stack[0].panel, '__risk_gate');
  assert.deepEqual(plan.stack[0].surfaces, ['Modal/Drawer']);
  assert.ok(plan.dim.length > 0, 'background surfaces dimmed');
  for (const s of plan.stack.slice(1)) {
    assert.ok(!s.surfaces.includes('Composer'), 'no inline Composer under destructive gate: ' + s.panel);
    assert.ok(!s.surfaces.includes('Queue'), 'no inline Queue under destructive gate: ' + s.panel);
  }
});

test('§5.2 rule 2: awaiting-approval → Queue pinned at 0 regardless of intent', () => {
  const plan = C.composePlan({ domain: 'brain', workState: 'awaiting-approval', capabilities: ['*'] });
  assert.equal(plan.stack[0].pinned, true);
  assert.ok(plan.stack[0].surfaces.includes('Queue'), 'Queue present on the pinned panel');
});

test('§5.1: unknown intent → Feed fallback only', () => {
  const plan = C.composePlan({ domain: 'output', intent: 'telepathy' });
  assert.equal(plan.fallback, true);
  assert.equal(plan.surface, 'Feed');
  assert.equal(plan.stack.length, 0);
});

test('§19.3 capability filter: action surfaces hidden for ungranted verbs, panel not removed', () => {
  const plan = C.composePlan({ domain: 'control', capabilities: ['fs.read'] });
  const comp = plan.stack.find((s) => s.panel === 'computer');
  assert.ok(comp, 'panel still mounted (dim, never hide)');
  assert.ok(comp.actionSurfacesHidden.includes('Detail'), 'control.take surface filtered');
});

test('§19.3 device density: mobile collapses Detail→Summary, classes preserved', () => {
  const d = C.composePlan({ domain: 'output', device: 'desktop', capabilities: ['*'] });
  const m = C.composePlan({ domain: 'output', device: 'mobile', capabilities: ['*'] });
  const hasDetail = d.stack.some((s) => s.surfaces.includes('Detail'));
  const hasSummary = m.stack.some((s) => s.surfaces.includes('Summary'));
  assert.ok(hasDetail && hasSummary, 'Detail class preserved via Summary on mobile');
});

test('§4.6 rule 28: every omitted entry uses a canonical omittedBecause', () => {
  const combos = [
    { domain: 'now' }, { domain: 'chat', risk: 'secret' }, { domain: 'work', workState: 'blocked' },
    { domain: 'agents', capabilities: [] }, { domain: 'connect', device: 'mobile' },
    { domain: 'system', intent: 'admin', risk: 'destructive', workState: 'awaiting-approval' },
  ];
  for (const ctx of combos) {
    const plan = C.composePlan(ctx);
    for (const o of plan.omitted) {
      assert.ok(C.OMIT_REASONS.includes(o.omittedBecause), 'illegal omittedBecause: ' + o.omittedBecause);
      for (const s of plan.stack) for (const x of (s.surfacesOmitted || [])) {
        assert.ok(C.OMIT_REASONS.includes(x.omittedBecause), 'illegal surface omittedBecause: ' + x.omittedBecause);
      }
    }
  }
});

test('§4.6 determinism: same tuple → byte-identical plan', () => {
  const ctx = { domain: 'output', risk: 'write', device: 'mobile', capabilities: ['harness.run'], attention: { queueCount: 2 } };
  const a = C.composePlan(ctx);
  const b = C.composePlan(ctx);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('§5.1 permissions from real grants: capability list shapes the plan (operator sees, worker hides)', () => {
  const op = C.composePlan({ domain: 'work', capabilities: ['*'] });
  const w = C.composePlan({ domain: 'work', capabilities: ['fs.read'] });
  const opGoals = op.stack.find((s) => s.panel === 'goals');
  const wGoals = w.stack.find((s) => s.panel === 'goals');
  assert.deepEqual(opGoals.actionSurfacesHidden, [], 'operator keeps Board actions');
  assert.ok(wGoals.actionSurfacesHidden.includes('Board'), 'worker loses goal.create surface');
});

test('whoami mount: identity projection carries no token material', async () => {
  const { Gateway } = require('../src/gateway/server');
  const { HashChain } = require('../src/gateway/hash-chain');
  const { match } = require('../src/gateway/http-mounts');
  const gw = new Gateway({ bots: { forge: { token: 'fw-tok', role: 'worker', capabilities: ['fs.read'] } }, chain: new HashChain() });
  const target = gw.mounts.find((m) => match(m, 'GET', '/v2/whoami'));
  assert.ok(target, 'whoami mount loaded');
  const res = { status: null, body: '', writeHead(s) { this.status = s; }, write(s) { if (s) this.body += s; }, end(s) { if (s) this.body += s; }, on() {} };
  const nodeUrl = require('node:url');
  await target.handle(gw, { method: 'GET', url: '/v2/whoami', headers: {}, on() {} }, res, { url: new nodeUrl.URL('/v2/whoami', 'http://x'), params: {}, bot: gw.bots.forge && { name: 'forge', role: 'worker', capabilities: ['fs.read'] } });
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.deepEqual(j, { name: 'forge', role: 'worker', capabilities: ['fs.read'] });
  assert.ok(!res.body.includes('fw-tok'), 'token never projected');
});
