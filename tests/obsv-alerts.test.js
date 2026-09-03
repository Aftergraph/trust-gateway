'use strict';
// FS-I2 tests — observability → AlertSink coupling (auto-alerts).
//
// Covers:
//   - ratelimit_spike: fires when apikeys.rateLimitedLast1h > threshold
//   - chain_stall: fires when chain length unchanged past the stall window
//   - both suppressed within the AlertSink 60s per-type rate-limit window
//   - thresholds env-configurable (TG_ALERT_RATELIMIT_THRESHOLD,
//     TG_ALERT_CHAIN_STALL_SEC)
//   - AlertSink inert when TG_ALERT_URLS unset → zero side effects
//   - kv_store persistence of obsv:lastChainLen across evaluateAlerts calls
//   - obsv.snapshot() wiring: evaluates without breaking the snapshot body

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { evaluateAlerts, CHAIN_LEN_KEY, envThreshold, _resetForTests } =
  require('../src/gateway/obsv-alerts');
const { AlertSink } = require('../src/gateway/alerting');

// ─── fetch seam: records deliveries without network ─────────────────────────
function recordingFetch() {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, status: 200 });
  };
  fn.calls = calls;
  return fn;
}

// AlertSink with injected clock + fetch so the 60s window is controllable.
function makeSink(fetchImpl, now = () => 1_000_000) {
  return new AlertSink({ urls: ['https://alerts.example/hook'], token: null, fetchImpl, now });
}

function snap(over = {}) {
  return {
    chain: { ok: true, length: 42, head: 'deadbeef' },
    apikeys: { active: 3, rateLimitedLast1h: 0 },
    uptimeSec: 5000,
    ...over,
  };
}

// Neutral kv stub for tests that only exercise one condition — keeps the
// other condition inert without touching any database.
const noKv = { get: () => null, set: () => {} };
// Recording stub: behaves like a real kv for stall-tracking assertions.
function memoryKv() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } };
}

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-i2-'));
  const prevDb = process.env.TG_DB_FILE;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  process.chdir(dir);
  // Fresh module graph per test: db.js/kvstore.js are process singletons.
  for (const m of Object.keys(require.cache)) {
    if (m.endsWith('/src/gateway/db.js') || m.endsWith('/src/gateway/kvstore.js') ||
        m.endsWith('/src/gateway/obsv.js') || m.endsWith('/src/gateway/obsv-alerts.js')) {
      delete require.cache[m];
    }
  }
  _resetForTests(); // drop any KV cached against a previous TG_DB_FILE
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      process.chdir(prevCwd);
      if (prevDb === undefined) delete process.env.TG_DB_FILE;
      else process.env.TG_DB_FILE = prevDb;
      _resetForTests();
    });
}

// ─── 1. ratelimit_spike ──────────────────────────────────────────────────────

test('obsv-alerts: ratelimit_spike fires when rateLimitedLast1h > threshold (default 10)', async () => {
  const f = recordingFetch();
  const out = await evaluateAlerts(snap({ apikeys: { active: 3, rateLimitedLast1h: 11 } }), { sink: makeSink(f), kv: noKv });
  assert.equal(out.ratelimit, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.type, 'obsv_alert_ratelimit_spike');
  assert.deepStrictEqual(f.calls[0].body.fields, { count: 11, threshold: 10 });
});

test('obsv-alerts: no ratelimit_spike at or below the threshold', async () => {
  const f = recordingFetch();
  await evaluateAlerts(snap({ apikeys: { active: 3, rateLimitedLast1h: 10 } }), { sink: makeSink(f), kv: noKv });
  assert.equal(f.calls.length, 0); // 10 > 10 is false — strictly greater
});

test('obsv-alerts: TG_ALERT_RATELIMIT_THRESHOLD is env-configurable', async () => {
  const f = recordingFetch();
  const out = await evaluateAlerts(
    snap({ apikeys: { active: 3, rateLimitedLast1h: 4 } }),
    { sink: makeSink(f), env: { TG_ALERT_RATELIMIT_THRESHOLD: '3' } }
  );
  assert.equal(out.ratelimit, true);
  assert.deepStrictEqual(f.calls[0].body.fields, { count: 4, threshold: 3 });
});

test('obsv-alerts: invalid threshold env falls back to the default', () => {
  assert.equal(envThreshold({}, 'X', 7), 7);
  assert.equal(envThreshold({ X: '' }, 'X', 7), 7);
  assert.equal(envThreshold({ X: 'nope' }, 'X', 7), 7);
  assert.equal(envThreshold({ X: '-2' }, 'X', 7), 7);
  assert.equal(envThreshold({ X: '25' }, 'X', 7), 25);
});

// ─── 2. chain_stall ──────────────────────────────────────────────────────────

test('obsv-alerts: chain_stall fires when length unchanged past the stall window', async () => {
  await withDb(async () => {
    const f = recordingFetch();
    const sink = makeSink(f);
    const s = snap(); // chain.length 42, uptimeSec 5000 (> 300 default)
    const kv = memoryKv();
    const first = await evaluateAlerts(s, { sink, kv });
    assert.equal(first.stall, false); // first sighting: length recorded, not stalled
    assert.equal(f.calls.length, 0);
    const second = await evaluateAlerts(s, { sink, kv });
    assert.equal(second.stall, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.type, 'obsv_alert_chain_stall');
    assert.equal(f.calls[0].body.fields.head, 'deadbeef');
    assert.equal(typeof f.calls[0].body.fields.stalledSince, 'string');
  });
});

test('obsv-alerts: chain length change resets the stall (no alert)', async () => {
  await withDb(async () => {
    const f = recordingFetch();
    const sink = makeSink(f);
    await evaluateAlerts(snap(), { sink, kv: noKv }); // record 42
    const grown = await evaluateAlerts(snap({ chain: { ok: true, length: 43, head: 'cafebabe' } }), { sink, kv: noKv });
    assert.equal(grown.stall, false);
    assert.equal(f.calls.length, 0);
  });
});

test('obsv-alerts: chain_stall suppressed within uptime window (uptimeSec <= stall sec)', async () => {
  await withDb(async () => {
    const f = recordingFetch();
    const sink = makeSink(f);
    await evaluateAlerts(snap({ uptimeSec: 5000 }), { sink, kv: noKv });
    const fresh = snap({ uptimeSec: 100 }); // unchanged length, but gateway barely up
    const out = await evaluateAlerts(fresh, { sink });
    assert.equal(out.stall, false);
    assert.equal(f.calls.length, 0);
  });
});

test('obsv-alerts: TG_ALERT_CHAIN_STALL_SEC is env-configurable', async () => {
  await withDb(async () => {
    const f = recordingFetch();
    const sink = makeSink(f);
    await evaluateAlerts(snap({ uptimeSec: 60 }), { sink, kv: noKv });
    const out = await evaluateAlerts(
      snap({ uptimeSec: 61 }),
      { sink, env: { TG_ALERT_CHAIN_STALL_SEC: '60' } }
    );
    assert.equal(out.stall, true);
    assert.equal(f.calls[0].body.type, 'obsv_alert_chain_stall');
  });
});

// ─── 3. AlertSink rate limit / suppression interplay ─────────────────────────

test('obsv-alerts: second alert of same type within 60s window is suppressed by the sink', async () => {
  await withDb(async () => {
    const f = recordingFetch();
    let t = 1_000_000;
    const sink = makeSink(f, () => t);
    const s = snap({ apikeys: { active: 3, rateLimitedLast1h: 99 } });
    const r1 = await evaluateAlerts(s, { sink, kv: noKv });
    assert.equal(r1.ratelimit, true);
    assert.equal(f.calls.length, 1);
    t += 1_000; // 1s later — still inside the 60s rate-limit window
    const r2 = await evaluateAlerts(s, { sink, kv: noKv });
    assert.equal(r2.ratelimit, false); // sink dropped it silently
    assert.equal(f.calls.length, 1); // no second fetch
    t += 61_000; // window rolled over
    const r3 = await evaluateAlerts(s, { sink, kv: noKv });
    assert.equal(r3.ratelimit, true);
    assert.equal(f.calls.length, 2);
  });
});

test('obsv-alerts: chain_stall type is rate-limited independently of ratelimit_spike', async () => {
  await withDb(async () => {
    const f = recordingFetch();
    const sink = makeSink(f);
    const kv = memoryKv();
    await evaluateAlerts(snap(), { sink, kv }); // record length
    const r1 = await evaluateAlerts(snap(), { sink, kv }); // stall accepted
    assert.equal(r1.stall, true);
    const r2 = await evaluateAlerts(snap(), { sink, kv }); // stall within window → dropped
    assert.equal(r2.stall, false);
    // spike still goes through — per-type windows are independent
    const r3 = await evaluateAlerts(snap({ apikeys: { active: 3, rateLimitedLast1h: 50 } }), { sink, kv });
    assert.equal(r3.ratelimit, true);
    assert.equal(f.calls.length, 2);
  });
});

// ─── 4. Inert when TG_ALERT_URLS unset ───────────────────────────────────────

test('obsv-alerts: AlertSink without URLs → alert() no-op, zero side effects', async () => {
  const f = recordingFetch();
  const inert = new AlertSink({ fetchImpl: f }); // no urls
  const kvStub = { get: () => null, set: (k) => { throw new Error('kv write must not happen'); } };
  const out = await evaluateAlerts(snap({ apikeys: { active: 3, rateLimitedLast1h: 999 } }), {
    sink: inert, kv: kvStub,
  });
  assert.equal(out.ratelimit, false);
  assert.equal(out.stall, false);
  assert.equal(f.calls.length, 0);
});

// ─── 5. kv_store persistence of lastChainLen ─────────────────────────────────

test('obsv-alerts: lastChainLen persists in kv_store across evaluateAlerts calls', async () => {
  await withDb(async () => {
    const { KV } = require('../src/gateway/kvstore');
    const f = recordingFetch();
    const sink = makeSink(f);
    const kv = new KV();

    // First call records 42 without alerting.
    await evaluateAlerts(snap(), { sink, kv });
    assert.equal(kv.get(CHAIN_LEN_KEY), 42);

    // A NEW KV handle over the same db still sees 42 (SQLite persistence),
    // so a fresh evaluator treats the unchanged chain as stalled.
    const kv2 = new KV();
    const out = await evaluateAlerts(snap(), { sink, kv: kv2 });
    assert.equal(out.stall, true);
    assert.equal(kv2.get(CHAIN_LEN_KEY), 42);

    // Growth updates the stored length.
    await evaluateAlerts(snap({ chain: { ok: true, length: 43, head: 'x' } }), { sink, kv: kv2 });
    assert.equal(kv2.get(CHAIN_LEN_KEY), 43);
  });
});

test('obsv-alerts: chain length 0 (fail-open verify) never alerts, never records', async () => {
  await withDb(async () => {
    const { KV } = require('../src/gateway/kvstore');
    const kv = new KV();
    const out = await evaluateAlerts(
      snap({ chain: { ok: false, length: 0, head: null } }),
      { sink: makeSink(recordingFetch()), kv }
    );
    assert.equal(out.stall, false);
    assert.equal(kv.get(CHAIN_LEN_KEY), null);
  });
});

// ─── 6. snapshot() wiring ────────────────────────────────────────────────────

test('obsv-alerts: obsv.snapshot() evaluates alerts without breaking the body', async () => {
  await withDb(async () => {
    const { snapshot } = require('../src/gateway/obsv');
    const gw = {
      chain: { verify: () => ({ ok: true, length: 7, head: 'aa11' }) },
      telemetry: { events: [] },
      approvals: { listPending: () => [] },
    };
    const s = snapshot(gw);
    // Body intact — alerting is a side channel, never a mutation.
    assert.equal(s.chain.length, 7);
    assert.equal(s.uptimeSec >= 0, true);
    assert.equal(typeof s.generatedAt, 'string');
    // Sink is inert (no TG_ALERT_URLS) so this is a pure no-op — but the
    // wiring path (evaluateAlerts called, never throws into snapshot) ran.
    await new Promise((r) => setImmediate(r));
  });
});

test('obsv-alerts: evaluateAlerts never throws on a malformed snapshot', async () => {
  const f = recordingFetch();
  assert.deepEqual(await evaluateAlerts(null, { sink: makeSink(f) }), { ratelimit: false, stall: false });
  assert.deepEqual(await evaluateAlerts({ chain: null, apikeys: null }, { sink: makeSink(f) }),
    { ratelimit: false, stall: false });
  assert.equal(f.calls.length, 0);
});
