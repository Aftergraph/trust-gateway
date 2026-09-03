'use strict';
// FS-D2 — load smoke against a REAL spawned gateway process.
//   50 sequential + 10 parallel bearer requests on loopback,
//   p95 latency < 500ms, zero 5xx.
//
// The bearer request is GET /v1/audit (auth + chain read) — heavier than
// /healthz, closer to real console traffic. Zero deps beyond node: builtins.

const test = require('node:test');
const assert = require('node:assert');

const { spawnGateway, api, TOKENS } = require('./fs-helpers.js');

const SEQ = 50;
const PAR = 10;
const P95_BUDGET_MS = 500;

function p95(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

test('load smoke: p95 < 500ms on loopback, zero 5xx (50 seq + 10 par bearer)', async () => {
  const g = await spawnGateway({ brain: false });
  try {
    const latencies = [];
    const bad = [];

    // ── 50 sequential bearer requests ──────────────────────────────
    for (let i = 0; i < SEQ; i++) {
      const t0 = process.hrtime.bigint();
      const res = await api(g.base, 'GET', '/v1/audit', { token: TOKENS.forge });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      latencies.push(ms);
      if (res.status >= 500) bad.push({ phase: `seq#${i}`, status: res.status });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.verified.ok, true);
    }

    // ── 10 parallel bearer requests ────────────────────────────────
    const parResults = await Promise.all(
      Array.from({ length: PAR }, async (_, i) => {
        const t0 = process.hrtime.bigint();
        const res = await api(g.base, 'GET', '/v1/audit', { token: TOKENS.forge });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        return { i, ms, status: res.status, verified: res.json && res.json.verified };
      })
    );
    for (const r of parResults) {
      latencies.push(r.ms);
      if (r.status >= 500) bad.push({ phase: `par#${r.i}`, status: r.status });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.verified && r.verified.ok, true);
    }

    assert.strictEqual(latencies.length, SEQ + PAR);
    assert.deepStrictEqual(bad, [], `zero 5xx required, got: ${JSON.stringify(bad)}`);

    const p = p95(latencies);
    assert.ok(p < P95_BUDGET_MS, `p95 ${p.toFixed(1)}ms must be < ${P95_BUDGET_MS}ms (max ${Math.max(...latencies).toFixed(1)}ms)`);
  } finally {
    await g.close();
  }
});
