'use strict';
// FS-I4 tests — audit-log export (webhook + S3 stub, operator-gated).
//
// Covers:
//   - webhook delivery: real local HTTP receiver records POSTs (3s timeout
//     configured, not waited on)
//   - backoff: 3 webhook failures in 60s → suppressed 5 min +
//     audit_export_backoff row; entries during suppression are dropped
//     (and the audit append still succeeds)
//   - rate limit: >10 sends within 1s window are refused (rate_limited)
//   - S3 stub: writes data/audit-export/<tenant>/<date>.jsonl locally,
//     seals s3_upload_pending {bucket,key} + one-time audit_export_s3_stub
//   - test endpoint: operator 200 {webhookOk,s3StubOk,lastError},
//     worker 403 + audit_export_denied
//   - env-off: both sinks inert — zero fetches, zero files, zero extra
//     audit rows (byte-identical legacy), no 'audit' listener registered
//   - never blocks audit append: a webhook that hangs past the timeout
//     still leaves the chain entry sealed
//   - re-entrancy: the module's own audit rows are never re-exported

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { ExportSink, getExportSink, BACKOFF_FAILURES } =
  require('../src/gateway/audit-export');
const { Gateway } = require('../src/gateway/server');

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-i4-')); }

// ─── local webhook receiver ─────────────────────────────────────────────────
function fakeWebhook({ status = 200, delayMs = 0 } = {}) {
  const deliveries = [];
  const server = http0.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* non-JSON */ }
      deliveries.push({ method: req.method, body: parsed });
      const respond = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
      };
      if (delayMs > 0) setTimeout(respond, delayMs); else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/hook`,
      deliveries,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
const http0 = require('node:http');

function entry(seq, type = 'chat_action', tenant = 'main') {
  return { seq, ts: Date.now(), hash: `h${seq}`, payload: { type, tenant } };
}

function makeGateway(opts = {}) {
  return new Gateway({
    bots: {
      atlas: { token: 'tok-i4-op', role: 'operator', capabilities: ['*'] },
      forge: { token: 'tok-i4-wk', role: 'worker', capabilities: ['fs.read'] },
    },
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
    ...opts,
  });
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = require('node:http').createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function post(port, path, token, body) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function lastTypes(gw) { return gw.chain.entries.map((e) => e.payload.type); }

// ─── webhook delivery ───────────────────────────────────────────────────────

test('webhook sink delivers sealed entries as POST JSON (3s timeout)', async () => {
  const hook = await fakeWebhook();
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    const gw = makeGateway();
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    const out = await sink.emit(entry(1));
    assert.equal(out.webhookOk, true);
    assert.equal(hook.deliveries.length, 1);
    assert.equal(hook.deliveries[0].method, 'POST');
    assert.equal(hook.deliveries[0].body.hash, 'h1');
    assert.equal(hook.deliveries[0].body.payload.type, 'chat_action');
    assert.ok(sink.timeoutMs <= 3000);
  });
  await hook.close();
});

test('webhook failure records audit_export_webhook row + lastError', async () => {
  const hook = await fakeWebhook({ status: 500 });
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    const gw = makeGateway();
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    const out = await sink.emit(entry(1));
    assert.equal(out.webhookOk, false);
    assert.equal(out.lastError, 'http_500');
    assert.ok(lastTypes(gw).includes('audit_export_webhook'));
  });
  await hook.close();
});

test('rate limit: at most 10 webhook sends per rolling second', async () => {
  const hook = await fakeWebhook();
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    const gw = makeGateway();
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    const results = [];
    for (let i = 0; i < 13; i++) results.push(await sink.emit(entry(i + 1)));
    const oks = results.filter((r) => r.webhookOk).length;
    const limited = results.filter((r) => !r.webhookOk && r.lastError === null).length;
    assert.equal(oks, 10, `expected exactly 10 delivered, got ${oks}`);
    assert.equal(limited, 3);
  });
  await hook.close();
});

// ─── backpressure / backoff ─────────────────────────────────────────────────

test('backoff: 3 webhook failures in 60s → 5min suppression + audit_export_backoff', async () => {
  const hook = await fakeWebhook({ status: 500 });
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    const gw = makeGateway();
    const { ExportSink: S, BACKOFF_SUPPRESS_MS } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    for (let i = 0; i < BACKOFF_FAILURES; i++) await sink.emit(entry(i + 1));
    assert.ok(lastTypes(gw).includes('audit_export_backoff'));
    const backoffRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'audit_export_backoff');
    assert.equal(backoffRow.sink, 'webhook');
    const tsBefore = sink.now();
    // Next emit is suppressed WITHOUT a delivery attempt...
    const calls = hook.deliveries.length;
    const out = await sink.emit(entry(99));
    assert.equal(out.webhookOk, false);
    assert.equal(hook.deliveries.length, calls, 'no fetch during suppression');
    // ...and the suppression window is 5 minutes.
    assert.equal(BACKOFF_SUPPRESS_MS, 300_000);
    assert.ok(sink._suppressUntil > tsBefore);
  });
  await hook.close();
});

test('operator self-test bypasses an active backoff and reports true state', async () => {
  const hook = await fakeWebhook({ status: 500 });
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    const gw = makeGateway();
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    for (let i = 0; i < 3; i++) await sink.emit(entry(i + 1));
    const calls = hook.deliveries.length;
    const out = await sink.testDelivery();
    assert.equal(out.webhookOk, false, 'still failing → false, not cached suppression');
    assert.equal(hook.deliveries.length, calls + 1, 'probe bypassed backoff');
    assert.equal(out.lastError, 'http_500');
  });
  await hook.close();
});

// ─── S3 stub ────────────────────────────────────────────────────────────────

test('S3 stub writes local jsonl fallback + s3_upload_pending rows, no SDK', async () => {
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_S3_BUCKET: 'acme-audit-archive', TG_AUDIT_EXPORT_S3_REGION: 'eu-central-1' }, async () => {
    const gw = makeGateway();
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    const e = entry(1, 'chat_action', 'tnt_acme');
    const out = await sink.emit(e);
    assert.equal(out.s3StubOk, true);
    const file = path.join(dir, 'audit-export', 'tnt_acme', new Date(e.ts).toISOString().slice(0, 10) + '.jsonl');
    assert.ok(fs.existsSync(file), 'fallback jsonl exists');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].hash, 'h1');
    // untagged entry lands under main/
    const e2 = entry(2);
    await sink.emit(e2);
    assert.ok(fs.existsSync(path.join(dir, 'audit-export', 'main', new Date(e2.ts).toISOString().slice(0, 10) + '.jsonl')));
    // audit rows: one-time stub announcement + one s3_upload_pending per entry
    const types = lastTypes(gw);
    assert.equal(types.filter((t) => t === 'audit_export_s3_stub').length, 1);
    const pending = gw.chain.entries.map((p2) => p2.payload).filter((p) => p.type === 's3_upload_pending');
    assert.equal(pending.length, 2);
    assert.ok(pending[0].bucket === 'acme-audit-archive');
    assert.ok(pending[0].key.endsWith('.jsonl') && pending[0].key.includes('/'));
    assert.equal(sink.region, 'eu-central-1');
  });
});

test('S3 stub region defaults to us-east-1', () => {
  const { ExportSink: S } = require('../src/gateway/audit-export');
  const sink = new S(null, { env: { TG_AUDIT_EXPORT_S3_BUCKET: 'b' }, dataDir: tmpDir() });
  assert.equal(sink.region, 'us-east-1');
  assert.equal(sink.webhookUrl, null);
});

// ─── operator-gated test endpoint ───────────────────────────────────────────

test('POST /v2/audit/export/test: operator gets probe result, audited', async () => {
  const hook = await fakeWebhook();
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url, TG_AUDIT_EXPORT_S3_BUCKET: 'bkt' }, async () => {
    const gw = makeGateway();
    gw.mounts.push(require('../src/gateway/mounts/117-audit-export'));
    const srv = await serve(gw);
    try {
      // Real flow: wireExportSink creates the env-configured sink; dataDir
      // points at tmp via env override so the stub write is hermetic.
      process.env.TG_AUDIT_EXPORT_DIR = path.join(dir, 'audit-export');
      const r = await post(srv.port, '/v2/audit/export/test', 'tok-i4-op');
      assert.equal(r.status, 200);
      assert.equal(r.json.webhookOk, true);
      assert.equal(r.json.s3StubOk, true);
      assert.ok(lastTypes(gw).includes('audit_export_test'));
      const testRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'audit_export_test');
      assert.equal(testRow.by, 'atlas');
    } finally {
      delete process.env.TG_AUDIT_EXPORT_DIR;
      await srv.close();
    }
  });
  await hook.close();
});

test('POST /v2/audit/export/test: worker → 403 + audit_export_denied', async () => {
  await withEnv({}, async () => {
    const gw = makeGateway();
    gw.mounts.push(require('../src/gateway/mounts/117-audit-export'));
    const srv = await serve(gw);
    try {
      const r = await post(srv.port, '/v2/audit/export/test', 'tok-i4-wk');
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'operator_required');
      assert.ok(lastTypes(gw).includes('audit_export_denied'));
    } finally { await srv.close(); }
  });
});

test('export test endpoint: env-off still answers with inert result', async () => {
  await withEnv({}, async () => {
    const gw = makeGateway();
    gw.mounts.push(require('../src/gateway/mounts/117-audit-export'));
    const srv = await serve(gw);
    try {
      const r = await post(srv.port, '/v2/audit/export/test', 'tok-i4-op');
      assert.equal(r.status, 200);
      assert.equal(r.json.webhookOk, false);
      assert.equal(r.json.s3StubOk, false);
      assert.ok(lastTypes(gw).includes('audit_export_test'));
    } finally { await srv.close(); }
  });
});

// ─── env-off: byte-identical legacy ─────────────────────────────────────────

test('env-off: sinks inert, zero fetches/files/extra audit rows, no listener', async () => {
  const hook = await fakeWebhook();
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url, TG_AUDIT_EXPORT_S3_BUCKET: 'x' }, async () => {
    // env SET here but sink constructed with a DIFFERENT (empty) env → inert
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(null, { env: {}, dataDir: path.join(dir, 'audit-export') });
    assert.equal(sink.inert, true);
    const out = await sink.emit(entry(1));
    assert.equal(out.webhookOk, false);
    assert.equal(out.s3StubOk, false);
    assert.equal(hook.deliveries.length, 0);
  });
  await hook.close();
  // And a full gateway with env truly unset: audit appends stay byte-identical
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: '' }, async () => {
    const gw = makeGateway();
    const before = gw.chain.entries.length;
    gw._audit({ type: 'chat_action', note: 'legacy' });
    const types = lastTypes(gw);
    assert.equal(types[types.length - 1], 'chat_action'); // no sink rows appended
    assert.ok(!types.some((t) => t.startsWith('audit_export_') || t === 's3_upload_pending'));
    assert.equal(hook.deliveries.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'audit-export')));
    // no 'audit' listener registered by the export tap when inert
    assert.equal(gw.listenerCount('audit'), 0);
  });
  await hook.close();
});

// ─── never blocks audit append ──────────────────────────────────────────────

test('hanging webhook never blocks or breaks audit append', async () => {
  const hook = await fakeWebhook({ delayMs: 250 }); // > emit wait budget
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    const gw = makeGateway();
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    const t0 = Date.now();
    const p = sink.emit(entry(1));
    const out = await p;
    const ms = Date.now() - t0;
    assert.ok(ms < 2500, `emit took ${ms}ms — must resolve well under the 3s timeout`);
    assert.equal(typeof out.webhookOk, 'boolean');
  });
  await hook.close();
});

test('events.js wiring: gateway audit event reaches the sink, fire-and-forget', async () => {
  const hook = await fakeWebhook();
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    delete require.cache[require.resolve('../src/gateway/events')];
    const { wireExportSink } = require('../src/gateway/events');
    const { getExportSink: G } = require('../src/gateway/audit-export');
    const gw = makeGateway();
    process.env.TG_AUDIT_EXPORT_DIR = path.join(dir, 'audit-export');
    try {
      wireExportSink(gw);
      assert.ok(gw._auditExportWired, 'tap registered');
      const delivered = new Promise((r) => {
        const { ExportSink: S } = require('../src/gateway/audit-export');
        void S;
        const sink = G(gw);
        const orig = sink.fetchImpl;
        sink.fetchImpl = async (...a) => { const res = await orig(...a); r(true); return res; };
      });
      gw._audit({ type: 'chat_action', note: 'wired' });
      assert.ok(await Promise.race([delivered, new Promise((r) => setTimeout(() => r(false), 2000))]), 'webhook got the sealed entry');
    } finally {
      delete process.env.TG_AUDIT_EXPORT_DIR;
    }
  });
  await hook.close();
});

test('re-entrancy: sink audit rows are never re-exported to the webhook', async () => {
  const hook = await fakeWebhook();
  const dir = tmpDir();
  await withEnv({ TG_AUDIT_EXPORT_WEBHOOK: hook.url }, async () => {
    const gw = makeGateway();
    const { ExportSink: S } = require('../src/gateway/audit-export');
    const sink = new S(gw, { env: process.env, dataDir: path.join(dir, 'audit-export') });
    await sink.emit(entry(1)); // succeeds (hook 200)
    const after = hook.deliveries.length;
    // Sealed sink rows must be ignored on re-delivery (no loop through 'audit')
    const ownRows = [
      { seq: 0, ts: Date.now(), hash: 'hx', payload: { type: 'audit_export_webhook', ok: false, error: 'http_500' } },
      { seq: 0, ts: Date.now(), hash: 'hy', payload: { type: 's3_upload_pending', bucket: 'b', key: 't/2026-01-01.jsonl' } },
      { seq: 0, ts: Date.now(), hash: 'hz', payload: { type: 'audit_export_backoff', sink: 'webhook' } },
    ];
    for (const e of ownRows) await sink.emit(e);
    assert.equal(hook.deliveries.length, after, 'own rows never re-exported');
  });
  await hook.close();
});
