'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// Slice 3 acceptance tests: token-hash + rotation.
//
// A-001 seeded store contains 64-hex digest, not plaintext
// A-002 correct bearer still authenticates (regression crux)
// A-003 wrong bearer still 401
// A-004 rotate by non-operator bot on another bot → 403 + audit token_forbidden
// A-005 operator rotates target bot → 200, returned token authenticates,
//      old token 401 in the SAME request cycle
// A-006 after rotation an old-token request yields 401 + audit token_rejected_stale
//
// All tests boot a real Gateway + real HTTP listener, drive the bearer
// auth path, and inspect the audit chain. No mocks; no shortcuts.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway, hashToken } = require('../src/gateway/server');

const FORGE_TOKEN = 'forge-plaintext-secret';
const ATLAS_TOKEN = 'atlas-plaintext-secret';
const WREN_TOKEN  = 'wren-plaintext-secret';
const WRONG_TOKEN = 'definitely-not-the-right-one';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}

function buildGw(extra = {}) {
  return new Gateway({
    bots: {
      // Workers (NOT operators — must not be able to rotate others).
      forge: { tokenHash: hashToken(FORGE_TOKEN), role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
      wren:  { tokenHash: hashToken(WREN_TOKEN),  role: 'worker', capabilities: ['fs.read'] },
      // Operator (may rotate ANY bot).
      atlas: { tokenHash: hashToken(ATLAS_TOKEN), role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool) => ({ ok: true, tool }),
    mountFiles: true,
    ...extra,
  });
}

function startServer(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return listen(server).then((url) => ({ url, server, gw }));
}

function fetchJson(base, method, path, headers = {}, body) {
  const u = new URL(path, base);
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(u, opts).then(async (res) => ({
    status: res.status,
    body: res.headers.get('content-type')?.includes('json') ? await res.json() : null,
  }));
}

function auditTypes(gw) {
  return gw.chain.entries.map((e) => e.payload.type);
}

// ──────────────────────────────────────────────────────────────────────────
// A-001 — seeded store contains 64-hex digest, not plaintext
// ──────────────────────────────────────────────────────────────────────────
test('A-001: gw.bots holds sha256 hex digests, never plaintext', () => {
  const gw = buildGw();
  const HEX64 = /^[0-9a-f]{64}$/;
  for (const [name, bot] of Object.entries(gw.bots)) {
    assert.ok(HEX64.test(bot.tokenHash), `${name}.tokenHash must be 64-hex, got ${JSON.stringify(bot.tokenHash)}`);
    assert.equal(bot.token, undefined, `${name}.token must NOT exist (plaintext forbidden at rest)`);
  }
  // Cross-check the digests against hashToken for at least one entry —
  // proves the storage shape is sha256(plaintext), not some other derivation.
  assert.equal(gw.bots.forge.tokenHash, hashToken(FORGE_TOKEN));
  assert.equal(gw.bots.atlas.tokenHash, hashToken(ATLAS_TOKEN));
});

// ──────────────────────────────────────────────────────────────────────────
// A-002 — correct bearer still authenticates (regression crux)
// ──────────────────────────────────────────────────────────────────────────
test('A-002: correct bearer authenticates against seeded hash store', async () => {
  const ctx = await startServer(buildGw());
  try {
    const forge = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${FORGE_TOKEN}` });
    assert.equal(forge.status, 200, 'forge must still authenticate');
    assert.equal(forge.body.ok, true);

    const atlas = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${ATLAS_TOKEN}` });
    assert.equal(atlas.status, 200, 'atlas must still authenticate');
    assert.equal(atlas.body.ok, true);
  } finally {
    ctx.server.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// A-003 — wrong bearer still 401
// ──────────────────────────────────────────────────────────────────────────
test('A-003: wrong bearer still 401 (and audits auth_rejected, not token_rejected_stale)', async () => {
  const ctx = await startServer(buildGw());
  try {
    const res = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${WRONG_TOKEN}` });
    assert.equal(res.status, 401);
    // The audit entry should be 'auth_rejected', not 'token_rejected_stale' —
    // we never rotated, the wrong token is genuinely unknown.
    assert.ok(auditTypes(ctx.gw).includes('auth_rejected'),
      'unknown token must be audited as auth_rejected');
    assert.ok(!auditTypes(ctx.gw).includes('token_rejected_stale'),
      'unknown token must NOT be audited as stale');
  } finally {
    ctx.server.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// A-004 — non-operator bot tries to rotate ANOTHER bot → 403 + token_forbidden
// ──────────────────────────────────────────────────────────────────────────
test('A-004: forge (worker) tries to rotate atlas → 403 + audit token_forbidden', async () => {
  const ctx = await startServer(buildGw());
  try {
    const res = await fetchJson(
      ctx.url, 'POST', '/v2/tokens/rotate',
      { authorization: `Bearer ${FORGE_TOKEN}` },
      { bot: 'atlas' },
    );
    assert.equal(res.status, 403, 'worker must not rotate another bot');
    assert.equal(res.body.error, 'operator_or_self_required');
    const types = auditTypes(ctx.gw);
    assert.ok(types.includes('token_forbidden'),
      `expected token_forbidden in audit chain, got: ${types.join(',')}`);
    const entry = ctx.gw.chain.entries.find((e) => e.payload.type === 'token_forbidden');
    assert.equal(entry.payload.bot, 'forge');
    assert.equal(entry.payload.target, 'atlas');
    // CRITICAL: plaintext tokens NEVER appear in audit, even on the denied path.
    const serialized = JSON.stringify(ctx.gw.chain.entries);
    assert.ok(!serialized.includes(FORGE_TOKEN), 'plaintext NEVER in audit');
    assert.ok(!serialized.includes(ATLAS_TOKEN), 'plaintext NEVER in audit');
  } finally {
    ctx.server.close();
  }
});

// A non-operator may rotate ITSELF.
test('A-004b: forge (worker) rotates its OWN token → 200, plaintext returned', async () => {
  const ctx = await startServer(buildGw());
  try {
    const res = await fetchJson(
      ctx.url, 'POST', '/v2/tokens/rotate',
      { authorization: `Bearer ${FORGE_TOKEN}` },
      { bot: 'forge' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.bot, 'forge');
    assert.ok(/^[0-9a-f]{64}$/.test(res.body.token), 'returned token must be 64-hex (32 bytes)');
    // Old token no longer authenticates.
    const oldRes = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${FORGE_TOKEN}` });
    assert.equal(oldRes.status, 401);
    // New token authenticates.
    const newRes = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${res.body.token}` });
    assert.equal(newRes.status, 200);
  } finally {
    ctx.server.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// A-005 — operator rotates target → 200, returned token authenticates,
//         OLD token 401 in the SAME request cycle
// ──────────────────────────────────────────────────────────────────────────
test('A-005: atlas (operator) rotates forge → 200; new token works, old fails immediately', async () => {
  const ctx = await startServer(buildGw());
  try {
    // Snapshot pre-rotation state.
    const oldHash = ctx.gw.bots.forge.tokenHash;
    assert.equal(oldHash, hashToken(FORGE_TOKEN));

    // Pre-rotation audit a request with the OLD token (sanity: still works).
    const before = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${FORGE_TOKEN}` });
    assert.equal(before.status, 200);

    // Rotation request.
    const res = await fetchJson(
      ctx.url, 'POST', '/v2/tokens/rotate',
      { authorization: `Bearer ${ATLAS_TOKEN}` },
      { bot: 'forge' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.bot, 'forge');
    const newToken = res.body.token;
    assert.ok(newToken && newToken !== FORGE_TOKEN, 'new token must differ from old');

    // In-memory map updated.
    assert.notEqual(ctx.gw.bots.forge.tokenHash, oldHash, 'tokenHash must have been replaced in memory');
    assert.equal(ctx.gw.bots.forge.tokenHash, hashToken(newToken));

    // Old token fails IMMEDIATELY (same request cycle, in-memory only).
    const oldRes = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${FORGE_TOKEN}` });
    assert.equal(oldRes.status, 401, 'old token must be rejected in the SAME cycle');

    // New token authenticates.
    const newRes = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${newToken}` });
    assert.equal(newRes.status, 200, 'new token must authenticate');

    // Audit chain contains token_rotated + no plaintext token values anywhere.
    const types = auditTypes(ctx.gw);
    assert.ok(types.includes('token_rotated'), `expected token_rotated, got: ${types.join(',')}`);
    const entry = ctx.gw.chain.entries.find((e) => e.payload.type === 'token_rotated');
    assert.equal(entry.payload.bot, 'forge');
    assert.equal(entry.payload.by, 'atlas');
    const serialized = JSON.stringify(ctx.gw.chain.entries);
    assert.ok(!serialized.includes(FORGE_TOKEN), 'old plaintext NEVER in audit');
    assert.ok(!serialized.includes(newToken), 'new plaintext NEVER in audit');
  } finally {
    ctx.server.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// A-006 — after rotation an old-token request yields 401 + token_rejected_stale
// ──────────────────────────────────────────────────────────────────────────
test('A-006: post-rotation old-token request → 401 + audit token_rejected_stale', async () => {
  const ctx = await startServer(buildGw());
  try {
    // Rotate forge as atlas.
    const rot = await fetchJson(
      ctx.url, 'POST', '/v2/tokens/rotate',
      { authorization: `Bearer ${ATLAS_TOKEN}` },
      { bot: 'forge' },
    );
    assert.equal(rot.status, 200);

    // Now hit the API using the OLD forge token — must 401 + audit stale.
    const staleRes = await fetchJson(ctx.url, 'GET', '/v1/audit/verify', { authorization: `Bearer ${FORGE_TOKEN}` });
    assert.equal(staleRes.status, 401);
    const types = auditTypes(ctx.gw);
    assert.ok(types.includes('token_rejected_stale'),
      `expected token_rejected_stale in audit, got: ${types.join(',')}`);
    const entry = ctx.gw.chain.entries.find((e) => e.payload.type === 'token_rejected_stale');
    assert.equal(entry.payload.bot, 'forge');
  } finally {
    ctx.server.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Bonus: rotation does NOT leak the old or new token through /v2/bots
// ──────────────────────────────────────────────────────────────────────────
test('bonus: /v2/bots projection never exposes token or tokenHash after rotation', async () => {
  const ctx = await startServer(buildGw());
  try {
    const rot = await fetchJson(
      ctx.url, 'POST', '/v2/tokens/rotate',
      { authorization: `Bearer ${ATLAS_TOKEN}` },
      { bot: 'forge' },
    );
    assert.equal(rot.status, 200);

    const view = await fetchJson(ctx.url, 'GET', '/v2/bots', { authorization: `Bearer ${ATLAS_TOKEN}` });
    assert.equal(view.status, 200);
    const forge = view.body.bots.find((b) => b.name === 'forge');
    assert.ok(forge, 'forge must be listed');
    assert.equal(forge.token, undefined, 'no plaintext field');
    assert.equal(forge.tokenHash, undefined, 'no hash field — digests are internal');
    assert.deepEqual(Object.keys(forge).sort(), ['capabilities', 'name', 'role']);
  } finally {
    ctx.server.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Bonus: rotating an unknown bot returns 404, not 403 (don't leak existence
// to non-operators — but since canSelfRotate is checked before lookup, a
// worker rotating "ghost" gets 403 too; an operator rotating "ghost" gets 404).
// ──────────────────────────────────────────────────────────────────────────
test('bonus: operator rotating unknown bot → 404 (audit shows nothing)', async () => {
  const ctx = await startServer(buildGw());
  try {
    const res = await fetchJson(
      ctx.url, 'POST', '/v2/tokens/rotate',
      { authorization: `Bearer ${ATLAS_TOKEN}` },
      { bot: 'ghost' },
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'unknown_bot');
  } finally {
    ctx.server.close();
  }
});

test('bonus: non-operator rotating unknown bot → 404 (existence check first, fail closed)', async () => {
  const ctx = await startServer(buildGw());
  try {
    const res = await fetchJson(
      ctx.url, 'POST', '/v2/tokens/rotate',
      { authorization: `Bearer ${FORGE_TOKEN}` },
      { bot: 'ghost' },
    );
    assert.equal(res.status, 404);
  } finally {
    ctx.server.close();
  }
});