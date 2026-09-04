'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'goals.js');

test('goals panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/goals.js exists');
});

test('goals panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'goals.js must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
});

test('goals panel registers itself in TG_PANELS', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]goals['"]/);
  assert.match(js, /render/);
});

test('goals panel uses the shared TG surface + goals API', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/goals/);
  assert.match(js, /\/v2\/slash/);
  assert.match(js, /\/v2\/bots/);
  assert.match(js, /onAudit/);
});

test('goals panel: goal card renders text/status/owner + steps table columns', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  for (const col of ['tool', 'state', 'attempts', 'lastDecision']) {
    assert.ok(js.includes("'" + col + "'"), 'steps table has column ' + col);
  }
  assert.match(js, /goal-card/);
  assert.match(js, /goal-owner/);
  // decision color classes for the policy outcomes
  for (const cls of ['ld-allow', 'ld-approved', 'ld-needs', 'ld-deny']) {
    assert.ok(js.includes(cls), 'decision color class ' + cls);
  }
  // status pill classes for every goal status
  for (const cls of ['status-active', 'status-paused', 'status-done', 'status-cleared']) {
    assert.ok(js.includes(cls), 'status pill class ' + cls);
  }
});

test('goals panel: card buttons + add form + slash console wired', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(js.includes("'step now'"), 'step now button');
  assert.ok(js.includes("'pause'"), 'pause button');
  assert.ok(js.includes("'resume'"), 'resume button');
  assert.ok(js.includes("'delete'"), 'delete button');
  assert.match(js, /\/step'/, 'calls POST /v2/goals/:id/step');
  assert.match(js, /\/resume'/, 'calls POST /v2/goals/:id/resume');
  assert.match(js, /\/goal pause /, 'pause goes through slash');
  assert.match(js, /\/goal clear /, 'clear goes through slash');
  assert.match(js, /steps = \[\{ tool \}\]/, 'add form sends one-step tool');
});

test('goals panel: onAudit refetches touched goal on goal_* events', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  const m = js.match(/onAudit\(\(e\) => {[\s\S]*?\n    }\);/);
  assert.ok(m, 'onAudit handler block found');
  const block = m[0];
  assert.match(block, /goalId/, 'handler reads payload goalId');
  assert.match(block, /\/v2\/goals/, 'handler refetches the goal');
  assert.match(block, /indexOf\('goal'\)/, 'handler filters goal_* events');
});

// ── live HTTP over the real gateway ──

function startGateway() {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, gw, port: server.address().port })));
}

function req(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: Object.assign(
        { authorization: 'Bearer ' + token },
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
      ) },
      resolve
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function readBody(res) {
  let b = '';
  for await (const c of res) b += c;
  return JSON.parse(b || '{}');
}

test('live HTTP: gateway serves /panels/goals.js', async () => {
  const { server, port } = await startGateway();
  try {
    const res = await req(port, 'GET', '/panels/goals.js', 'tok-a');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('live HTTP: goals API works end-to-end (add → list → step → slash)', async () => {
  const { server, port } = await startGateway();
  try {
    // add goal with one governed step (fs.read is policy-allowed for '*')
    const add = await req(port, 'POST', '/v2/goals', 'tok-a', {
      text: 'panel smoke', owner: 'a', steps: [{ tool: 'fs.read', args: { path: 'README.md' } }],
    });
    assert.equal(add.statusCode, 201);
    const { goal } = await readBody(add);
    assert.equal(goal.status, 'active');
    assert.equal(goal.steps.length, 1);

    // list shows it
    const list = await readBody(await req(port, 'GET', '/v2/goals', 'tok-a'));
    assert.ok(list.goals.some((g) => g.id === goal.id));

    // step it once
    const step = await readBody(await req(port, 'POST', '/v2/goals/' + goal.id + '/step', 'tok-a', {}));
    assert.equal(typeof step.done, 'boolean');
    assert.ok(step.goal);

    // slash status returns the goal
    const slash = await readBody(await req(port, 'POST', '/v2/slash', 'tok-a', { cmd: '/goal status ' + goal.id }));
    assert.equal(slash.ok, true);
    assert.equal(slash.goal.id, goal.id);

    // clear via slash
    const cleared = await readBody(await req(port, 'POST', '/v2/slash', 'tok-a', { cmd: '/goal clear ' + goal.id }));
    assert.equal(cleared.ok, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});