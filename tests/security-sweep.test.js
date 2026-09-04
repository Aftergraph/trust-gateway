'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // unit tests: no AIE runtime
// FS-D2 — security sweep over the same real-gateway battery pattern.
//
// Claim: every /v2 mount fails closed on auth, path traversal is refused,
// backup restore never escapes data/backups, and no response ever carries
// token material. Each assertion here is a claim from the site/AI-GOVERNANCE
// docs checked against the REAL spawned process — not a mock.

const test = require('node:test');
const assert = require('node:assert');

const { spawnGateway, api, TOKENS } = require('./fs-helpers.js');

test('FS-D2 security sweep: auth, traversal, secret hygiene', async () => {
  const g = await spawnGateway();
  try {
    const { base } = g;
    const forge = TOKENS.forge;
    const atlas = TOKENS.atlas;

    // ── 1. every /v2 bearer mount refuses requests without a token ──
    const protectedPaths = [
      ['GET', '/v1/audit'],
      ['GET', '/v1/audit/verify'],
      ['POST', '/v1/actions'],
      ['GET', '/v2/telemetry'],
      ['GET', '/v2/backup'],
      ['POST', '/v2/backup'],
      ['GET', '/v2/skills'],
      ['GET', '/v2/harness2/projects'],
      ['POST', '/v2/providers/plan'],
      ['GET', '/v2/adapters'],
    ];
    for (const [method, p] of protectedPaths) {
      const noAuth = await api(base, method, p, {
        body: method === 'POST' ? {} : undefined,
      });
      assert.ok(
        noAuth.status === 401 || noAuth.status === 403,
        `${method} ${p} without token → ${noAuth.status} (expected 401/403)`
      );
    }
    // garbage token is also refused
    const badTok = await api(base, 'GET', '/v1/audit', { token: 'not-a-token' });
    assert.strictEqual(badTok.status, 401);

    // ── 2. path traversal refused on artifacts ──────────────────────
    const trav = await api(base, 'POST', '/v1/actions', {
      token: forge,
      body: { tool: 'fs.read:../../etc/passwd' },
    });
    // fail-closed: either a refusal decision or a 4xx — never file contents
    assert.ok(trav.status >= 400 || trav.json.decision === 'deny' || trav.json.ok === false,
      `traversal attempt must not succeed: ${trav.status} ${JSON.stringify(trav.json).slice(0, 120)}`);
    if (trav.json && typeof trav.json.result === 'object' && trav.json.result !== null) {
      assert.ok(!/root:/.test(JSON.stringify(trav.json)), 'no /etc/passwd material in response');
    }

    // ── 3. backup restore name-traversal refused ────────────────────
    const badName = await api(base, 'POST', '/v2/backup/restore', {
      token: atlas,
      body: { name: '../../etc' },
    });
    assert.strictEqual(badName.status, 400); // mount regex rejects before FS access
    const unknown = await api(base, 'POST', '/v2/backup/restore', {
      token: atlas,
      body: { name: 'backup-2099-01-01T00-00-00-000Z' },
    });
    assert.strictEqual(unknown.status, 409); // exists-in-regex, missing on disk → fail closed

    // ── 4. secret hygiene: no token material in any fetched body ────
    const forgeTok = forge;
    const atlasTok = atlas;
    const bodies = [];
    for (const [method, p, tok] of [
      ['GET', '/v1/audit', forge],
      ['GET', '/healthz', null],
      ['GET', '/v2/telemetry', atlas],
      ['GET', '/v2/providers', forge],
      ['GET', '/v2/skills', forge],
      ['GET', '/v2/backup', atlas],
      ['POST', '/v2/providers/plan', forge],
    ]) {
      const r = await api(base, method, p, {
        token: tok || undefined,
        body: method === 'POST' ? { task: 'probe' } : undefined,
      });
      bodies.push({ p, text: JSON.stringify(r.json) });
    }
    for (const { p, text } of bodies) {
      assert.ok(!text.includes(forgeTok), `token material leaked in ${p}`);
      assert.ok(!text.includes(atlasTok), `token material leaked in ${p}`);
      // sk- style key patterns must never appear either
      assert.ok(!/sk-[a-zA-Z0-9]{8,}/.test(text), `API-key pattern leaked in ${p}`);
    }

    // ── 5. audit chain still verifies after all of the above ────────
    const ver = await api(base, 'GET', '/v1/audit/verify', { token: forge });
    assert.strictEqual(ver.status, 200);
    assert.strictEqual(ver.json.ok, true);
  } finally {
    await g.close();
  }
});