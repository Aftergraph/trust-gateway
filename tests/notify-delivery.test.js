const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

describe('FS-X1 notification delivery', () => {
  let tmpDir;
  let origEnv;
  let testServer;
  let testPort;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-x1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_NOTIFY_DELIVERY = '1';
    process.env.TG_OPERATOR_NOTIFY = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/kvstore')];
    delete require.cache[require.resolve('../src/gateway/operator-notify')];
    delete require.cache[require.resolve('../src/gateway/notify-delivery')];

    // Start a local HTTP server to receive webhook deliveries
    testServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        testServer.lastBody = body;
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
    testPort = testServer.address().port;
  });

  after(async () => {
    process.env = origEnv;
    if (testServer) await new Promise(r => testServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const d = require('../src/gateway/notify-delivery');
    assert.equal(d.enabled(), true);
  });

  it('deliver returns skipped when no prefs set', async () => {
    const d = require('../src/gateway/notify-delivery');
    const r = await d.deliver('test_event', { x: 1 });
    assert.equal(r.delivered, 0);
    assert.equal(r.subscribers.audit_chain, 0);
    assert.equal(r.subscribers.webhook, 0);
  });

  it('_deliverWebhook returns ok on 200', async () => {
    const d = require('../src/gateway/notify-delivery');
    const r = await d._deliverWebhook(`http://127.0.0.1:${testPort}/hook`, { hello: 'world' });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.ok(testServer.lastBody.includes('hello'));
  });

  it('_deliverWebhook returns ok:false on invalid URL', async () => {
    const d = require('../src/gateway/notify-delivery');
    const r = await d._deliverWebhook('not-a-url', {});
    assert.equal(r.ok, false);
  });

  it('_deliverWebhook returns ok:false on connection refused', async () => {
    const d = require('../src/gateway/notify-delivery');
    // Use a port nothing is listening on
    const r = await d._deliverWebhook('http://127.0.0.1:1/hook', {}, 500);
    assert.equal(r.ok, false);
  });

  it('inert when TG_NOTIFY_DELIVERY unset', async () => {
    delete process.env.TG_NOTIFY_DELIVERY;
    delete require.cache[require.resolve('../src/gateway/notify-delivery')];
    const d = require('../src/gateway/notify-delivery');
    assert.equal(d.enabled(), false);
    const r = await d.deliver('x', {});
    assert.equal(r.delivered, 0);
    assert.equal(r.skipped, true);
    process.env.TG_NOTIFY_DELIVERY = '1';
    delete require.cache[require.resolve('../src/gateway/notify-delivery')];
  });
});
