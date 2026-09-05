const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Gateway, hashToken } = require('../src/gateway/server');

describe('FS-X3 route limits', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-x3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_ROUTE_LIMITS = '1';
    process.env.TG_RATE_LEDGER = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/rate-ledger')];
    delete require.cache[require.resolve('../src/gateway/route-limits')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const rl = require('../src/gateway/route-limits');
    assert.equal(rl.enabled(), true);
  });

  it('set stores rule', () => {
    const rl = require('../src/gateway/route-limits');
    const r = rl.set('GET /v2/test', { maxHits: 10, windowMs: 60000 }, 'op1');
    assert.equal(r.ok, true);
    assert.equal(r.maxHits, 10);
    assert.equal(r.windowMs, 60000);
  });

  it('get returns stored rule', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('GET /v2/foo', { maxHits: 5, windowMs: 30000 }, 'op1');
    const r = rl.get('GET /v2/foo');
    assert.ok(r);
    assert.equal(r.maxHits, 5);
  });

  it('match finds exact rule', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('POST /v2/match-test', { maxHits: 100, windowMs: 60000 }, 'op1');
    const m = rl.match('POST', '/v2/match-test');
    assert.ok(m);
    assert.equal(m.maxHits, 100);
  });

  it('match returns null for unmatched route', () => {
    const rl = require('../src/gateway/route-limits');
    const m = rl.match('GET', '/v2/no-such-route');
    assert.equal(m, null);
  });

  it('check allows under limit', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('GET /v2/under', { maxHits: 100, windowMs: 60000 }, 'op1');
    const r = rl.check('GET', '/v2/under', Date.now());
    assert.equal(r.allowed, true);
    assert.ok(r.count <= 100);
  });

  it('check denies over limit', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('GET /v2/over', { maxHits: 1, windowMs: 60000 }, 'op1');
    rl.check('GET', '/v2/over', Date.now()); // first hit
    const r = rl.check('GET', '/v2/over', Date.now()); // second hit
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterMs > 0);
  });

  it('match finds bare-path rule for any method (set-contract)', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('/v2/bare-path', { maxHits: 3, windowMs: 60000 }, 'op1');
    const mGet = rl.match('GET', '/v2/bare-path');
    const mPost = rl.match('POST', '/v2/bare-path?x=1');
    assert.ok(mGet, 'bare-path rule must match GET');
    assert.ok(mPost, 'bare-path rule must match POST (query stripped)');
    assert.equal(mGet.maxHits, 3);
  });

  it('bare-path rule enforces 429 via check across methods', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('/v2/bare-over', { maxHits: 1, windowMs: 60000 }, 'op1');
    // A bare-path rule must constrain EVERY method (its own bucket per method);
    // hitting POST twice beyond maxHits=1 must deny on the second hit.
    assert.equal(rl.check('POST', '/v2/bare-over', Date.now()).allowed, true);
    const r = rl.check('POST', '/v2/bare-over', Date.now());
    assert.equal(r.allowed, false, 'second hit on bare-path rule must be denied');
    assert.equal(r.pattern, '/v2/bare-over');
    assert.ok(r.retryAfterMs > 0);
  });

  it('method-prefixed rule wins over bare-path rule', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('/v2/dual', { maxHits: 50, windowMs: 60000 }, 'op1');
    rl.set('POST /v2/dual', { maxHits: 5, windowMs: 60000 }, 'op1');
    assert.equal(rl.match('GET', '/v2/dual').maxHits, 50);
    assert.equal(rl.match('POST', '/v2/dual').maxHits, 5);
  });

  it('remove deletes rule', () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('GET /v2/removeme', { maxHits: 1, windowMs: 1000 }, 'op1');
    assert.equal(rl.remove('GET /v2/removeme'), true);
    assert.equal(rl.get('GET /v2/removeme'), null);
  });

  it('inert when TG_ROUTE_LIMITS unset', () => {
    delete process.env.TG_ROUTE_LIMITS;
    delete require.cache[require.resolve('../src/gateway/route-limits')];
    const rl = require('../src/gateway/route-limits');
    assert.equal(rl.enabled(), false);
    assert.equal(rl.set('x', { maxHits: 1, windowMs: 1 }, 'op'), null);
    assert.equal(rl.check('GET', '/x', Date.now()).skipped, true);
    process.env.TG_ROUTE_LIMITS = '1';
    delete require.cache[require.resolve('../src/gateway/route-limits')];
  });

  it('e2e: route rule enforced on legacy surface — 429 + audit-sealed', async () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('GET /v1/audit', { maxHits: 2, windowMs: 60000 }, 'op1');
    const gw = new Gateway({
      bots: { atlas: { tokenHash: hashToken('e2e-atlas'), role: 'operator', capabilities: [] } },
      dispatch: async () => ({ ok: true }),
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const { req, res, getStatus } = makeReqRes({ method: 'GET', url: '/v1/audit', token: 'e2e-atlas' });
      gw.handle(req, res);
      await new Promise((r) => setImmediate(r));
      statuses.push(getStatus());
    }
    assert.deepEqual(statuses, [200, 200, 429], 'third request must be 429');
    const sealed = gw.chain.since(0, { limit: 200 }).entries
      .some((e) => e.payload && e.payload.type === 'route_rate_limited');
    assert.ok(sealed, 'route_rate_limited must be audit-sealed');
  });

  it('e2e: route rule enforced on fn-route surface (operator fn mount)', async () => {
    const rl = require('../src/gateway/route-limits');
    rl.set('GET /v2/rate/limits', { maxHits: 1, windowMs: 60000 }, 'op1');
    const gw = new Gateway({
      bots: { atlas: { tokenHash: hashToken('e2e-atlas2'), role: 'operator', capabilities: [] } },
      dispatch: async () => ({ ok: true }),
    });
    const call1 = makeReqRes({ method: 'GET', url: '/v2/rate/limits', token: 'e2e-atlas2' });
    await gw.handle(call1.req, call1.res);
    await new Promise((r) => setImmediate(r));
    const call2 = makeReqRes({ method: 'GET', url: '/v2/rate/limits', token: 'e2e-atlas2' });
    await gw.handle(call2.req, call2.res);
    await new Promise((r) => setImmediate(r));
    assert.equal(call1.getStatus(), 200);
    assert.equal(call2.getStatus(), 429, 'fn-route beyond budget must be 429');
    assert.equal(JSON.parse(call2.getBody() || '{}').error, 'route_rate_limited');
  });
});

// ── e2e harness (mini) ───────────────────────────────────────────────────
function makeReqRes({ method = 'GET', url = '/', token = null, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  if (token) req.headers.authorization = 'Bearer ' + token;
  req.on = EventEmitter.prototype.on;
  let statusCode = null;
  let bodyStr = '';
  const res = {
    statusCode: null, // fn-mount handlers set res.statusCode directly
    writeHead(s) { statusCode = s; },
    setHeader() {}, // fn-mount handlers may set headers
    end(b) { bodyStr = typeof b === 'string' ? b : (b == null ? '' : String(b)); },
    once() {}, on() {},
  };
  process.nextTick(() => req.emit('end'));
  return {
    req, res,
    getStatus: () => statusCode || res.statusCode || 200,
    getBody: () => bodyStr,
  };
}
