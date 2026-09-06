// FS-X1 extension (2026-09-06): rate_bucket_near_limit seals are fanned out
// to L2 webhook subscribers (fire-and-forget, audit seal already durable).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Gateway, hashToken } = require('../src/gateway/server');

function makeReqRes(opts) {
  const req = new EventEmitter();
  req.method = opts.method || 'GET';
  req.url = opts.url || '/';
  req.headers = {};
  if (opts.token) req.headers.authorization = 'Bearer ' + opts.token;
  const res = {
    statusCode: null,
    writeHead(s) { res.statusCode = s; },
    setHeader() {},
    end(b) { bodyStr = typeof b === 'string' ? b : (b == null ? '' : String(b)); },
    once() {}, on() {},
  };
  let bodyStr = '';
  process.nextTick(() => req.emit('end'));
  return { req, res, getStatus: () => res.statusCode || 200, getBody: () => bodyStr };
}

describe('rate-alert webhook notifications', () => {
  let tmpDir;
  let origEnv;
  let testServer;
  let testPort;
  let received;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-alert-notify-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_RATE_LEDGER = '1';
    process.env.TG_ROUTE_LIMITS = '1';
    process.env.TG_NOTIFY_DELIVERY = '1';
    process.env.TG_OPERATOR_NOTIFY = '1';
    process.env.TG_WEBHOOK_SUBS = '1';
    for (const m of ['db', 'rate-ledger', 'route-limits', 'operator-notify', 'webhook-subs', 'notify-delivery']) {
      delete require.cache[require.resolve('../src/gateway/' + m)];
    }

    received = [];
    testServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, body: safeParse(body) });
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    testPort = testServer.address().port;
  });

  after(() => {
    testServer.close();
    process.env = origEnv;
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function safeParse(s) {
    try { return JSON.parse(s); } catch { return s; }
  }

  async function waitForReceive(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (received.length > 0) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return received.length > 0;
  }

  function makeGateway(name) {
    return new Gateway({
      bots: { [name]: { tokenHash: hashToken('rate-alert-' + name), role: 'operator', capabilities: [] } },
      dispatch: async () => ({ ok: true }),
    });
  }

  it('webhook subscriber receives rate_bucket_near_limit exactly once with count/maxHits', async () => {
    const subs = require('../src/gateway/webhook-subs');
    const rl = require('../src/gateway/route-limits');
    const created = subs.create({
      url: `http://127.0.0.1:${testPort}/hook`,
      eventTypes: ['rate_bucket_near_limit'],
      by: 'op-t3',
    });
    assert.ok(created && created.id > 0, 'subscription created');

    rl.set('GET /v2/rate/limits-near', { maxHits: 10, windowMs: 60000 }, 'op1');
    const gw = makeGateway('atlas-n1');
    for (let i = 1; i <= 10; i++) {
      const { req, res } = makeReqRes({ url: '/v2/rate/limits-near', token: 'rate-alert-atlas-n1' });
      await gw.handle(req, res);
      await new Promise((r) => setImmediate(r));
    }

    assert.ok(await waitForReceive(2500), 'webhook POST must arrive');
    const events = received.filter((x) => x.body && x.body.type === 'rate_bucket_near_limit');
    assert.equal(events.length, 1, 'exactly one delivery per window');
    assert.equal(events[0].body.payload.count, 8, 'sealed at the 80% crossing (8/10)');
    assert.equal(events[0].body.payload.maxHits, 10);
    assert.equal(events[0].body.payload.pattern, 'GET /v2/rate/limits-near');

    // The audit seal itself must exist too (deliver is a side-channel).
    const seals = gw.chain.since(0, { limit: 300 }).entries.filter((e) => e.payload && e.payload.type === 'rate_bucket_near_limit');
    assert.equal(seals.length, 1, 'audit seal exactly once');
  });

  it('inert when TG_NOTIFY_DELIVERY unset — no webhook delivery, seal still durable', async () => {
    received.length = 0;
    delete process.env.TG_NOTIFY_DELIVERY;
    for (const m of ['notify-delivery']) {
      delete require.cache[require.resolve('../src/gateway/' + m)];
    }
    const rl = require('../src/gateway/route-limits');
    rl.set('GET /v2/rate/limits-near2', { maxHits: 10, windowMs: 60000 }, 'op1');
    const gw = makeGateway('atlas-n2');
    for (let i = 1; i <= 8; i++) {
      const { req, res } = makeReqRes({ url: '/v2/rate/limits-near2', token: 'rate-alert-atlas-n2' });
      await gw.handle(req, res);
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(received.length, 0, 'no webhook when notify delivery disabled');
    const seals = gw.chain.since(0, { limit: 300 }).entries.filter((e) => e.payload && e.payload.type === 'rate_bucket_near_limit');
    assert.ok(seals.some((e) => e.payload.pattern === 'GET /v2/rate/limits-near2'), 'seal still durable regardless');
  });
});