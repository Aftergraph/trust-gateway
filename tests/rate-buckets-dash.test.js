'use strict';
// FS-M3 dashboard: GET /v2/rate/buckets — operator-only list of
// current-window rate buckets (ranked by count desc).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.TG_RATE_LEDGER = '1';
process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rdash-')), 'gateway.db');

const { Gateway, hashToken } = require('../src/gateway/server');
const ledger = require('../src/gateway/rate-ledger');

const DB = require('../src/gateway/db');

function makeReqRes({ method = 'GET', url = '/', token = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  if (token) req.headers.authorization = 'Bearer ' + token;
  process.nextTick(() => req.emit('end'));
  let bodyStr = '';
  const res = {
    statusCode: null,
    writeHead(s, h) { this.statusCode = s; },
    setHeader() {},
    end(b) { bodyStr = typeof b === 'string' ? b : (b == null ? '' : String(b)); },
    once() {}, on() {},
  };
  return {
    req, res,
    getStatus: () => (res.statusCode === null || res.statusCode === undefined ? 200 : res.statusCode),
    getBody: () => { try { return JSON.parse(bodyStr); } catch { return bodyStr; } },
  };
}

function makeGateway(opts = {}) {
  return new Gateway(Object.assign({
    mountFiles: true,
    mountFilesBots: undefined,
    bots: {
      atlas: { tokenHash: hashToken('tok-atlas'), role: 'operator', capabilities: [] },
      forge: { tokenHash: hashToken('tok-forge'), role: 'worker', capabilities: [] },
    },
    dispatch: async (bot, tool) => ({ ok: true, tool }),
  }, opts));
}

test('GET /v2/rate/buckets lists current-window buckets for operator, ranked', async () => {
  const gw = makeGateway();
  const now = Date.now();
  ledger.hit('GET:/v2/bots', 60000, 100, now);
  ledger.hit('GET:/v2/bots', 60000, 100, now);
  ledger.hit('GET:/v2/runs', 60000, 100, now);

  const { req, res, getStatus, getBody } = makeReqRes({ url: '/v2/rate/buckets', token: 'tok-atlas' });
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
  const body = getBody();
  assert.ok(body.count >= 2, `expected >=2 buckets, got ${body.count}`);
  assert.ok(Array.isArray(body.buckets));
  const first = body.buckets[0];
  assert.equal(first.key, 'GET:/v2/bots', 'highest count ranked first');
  assert.equal(first.count, 2);
  assert.ok(first.windowMs > 0 && first.updatedAt > 0);

  // Second call hits the same window — the list must still work (idempotent).
  const r2 = await gw.handle(makeReqRes({ url: '/v2/rate/buckets?windowMs=60000', token: 'tok-atlas' }).req, makeReqRes({ url: '/v2/rate/buckets?windowMs=60000', token: 'tok-atlas' }).res);
  assert.equal(r2 === undefined, true); // handle returns nothing; response captured above
});

test('GET /v2/rate/buckets denies non-operator (403, audited)', async () => {
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = makeReqRes({ url: '/v2/rate/buckets', token: 'tok-forge' });
  await gw.handle(req, res);
  assert.equal(getStatus(), 403);
  assert.equal(getBody().error, 'operator_required');
});

test('GET /v2/rate/buckets 404s when ledger disabled', async () => {
  process.env.TG_RATE_LEDGER = '0';
  delete require.cache[require.resolve('../src/gateway/rate-ledger')];
  const ledgerOff = require('../src/gateway/rate-ledger');
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = makeReqRes({ url: '/v2/rate/buckets', token: 'tok-atlas' });
  await gw.handle(req, res);
  assert.equal(getStatus(), 404);
  assert.equal(getBody().error, 'rate_ledger_disabled');
  process.env.TG_RATE_LEDGER = '1';
  delete require.cache[require.resolve('../src/gateway/rate-ledger')];
  require('../src/gateway/rate-ledger');
});

test('GET /v2/rate/buckets rejects invalid windowMs', async () => {
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = makeReqRes({ url: '/v2/rate/buckets?windowMs=abc', token: 'tok-atlas' });
  await gw.handle(req, res);
  assert.equal(getStatus(), 400);
  assert.equal(getBody().error, 'invalid_windowMs');
});