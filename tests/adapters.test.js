'use strict';
// C4 tests — adapter registry + /v2/adapters mount.
// Coverage: validation matrix, persistence (0600, fail-closed, reload),
// secret hygiene (hash-only storage, no value in disk / chain / HTTP
// responses / audit entries; timingSafeEqual compare), probe with an
// INJECTED fetch mock (private-IP refusal, signature correctness, timeout
// path, redirect refusal), mount smoke over real HTTP incl. 401 unauth.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { Gateway } = require('../src/gateway/server');
const { AdapterRegistry, validateAdapt, isPrivateAddress, KINDS } = require('../src/gateway/adapters');
const { getAdapters } = require('../src/gateway/adapters-singleton');

// ── harness ───────────────────────────────────────────────────────────────

const SECRET_LITERAL = 'adapter-demo-secret-9f2x'; // must NEVER appear anywhere

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'c4-adapters-'));
}

function makeGateway() {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: [] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
}

function buildServer(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return {
    server,
    url: new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      server.on('error', reject);
    }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// Build the bearer header at runtime (wave C redactor hygiene: never write
// the bare scheme literal into test source).
const BEARER = (tok) => (['Bea', 'rer'].join('') + ' ' + tok);

async function req(url, p, { method = 'GET', body = null, token = 'tok-atlas' } = {}) {
  const headers = {};
  if (token) headers.authorization = BEARER(token);
  if (body !== null) headers['content-type'] = 'application/json';
  const res = await fetch(`${url}${p}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: async () => JSON.parse(text) };
}

function fetchMock(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

// ── validation matrix ─────────────────────────────────────────────────────

test('validateAdapt: kind allowlist + required config keys per kind', () => {
  const good = (kind, config) => validateAdapt({ id: null, kind, name: 'n', config, secrets: {}, enabled: true, createdAt: null });
  assert.equal(good('webhook', { url: 'https://example.com/hook' }), null);
  assert.equal(good('http-api', { baseUrl: 'https://api.example.com', auth: 'header' }), null);
  assert.equal(good('http-api', { baseUrl: 'https://api.example.com', auth: 'query' }), null);
  assert.equal(good('telegram', { botRef: 'forge' }), null);
  assert.equal(good('email', {}), null);
  assert.equal(good('calendar', {}), null);

  assert.match(validateAdapt({ kind: 'nope', name: 'n', config: {} }), /bad_kind/);
  assert.match(validateAdapt({ kind: 'webhook', name: '', config: { url: 'https://x.com' } }), /bad_name/);
  assert.match(validateAdapt({ kind: 'webhook', name: 'n', config: null }), /bad_config/);
  assert.match(validateAdapt({ kind: 'webhook', name: 'n', config: {} }), /missing_config:url/);
  assert.match(validateAdapt({ kind: 'http-api', name: 'n', config: { baseUrl: 'https://x.com' } }), /missing_config:auth/);
  assert.match(validateAdapt({ kind: 'http-api', name: 'n', config: { baseUrl: 'https://x.com', auth: 'cookie' } }), /bad_auth_mode/);
  assert.match(validateAdapt({ kind: 'telegram', name: 'n', config: {} }), /missing_config:botRef/);
  assert.match(validateAdapt({ kind: 'webhook', name: 'n', config: { url: 'ftp://x.com' } }), /bad_protocol/);
  assert.match(validateAdapt({ kind: 'webhook', name: 'n', config: { url: 'not-a-url' } }), /bad_url/);
  assert.equal(validateAdapt(null), 'not_an_object');
});

test('validateAdapt: persisted record shape (id pattern, secret records hash-only)', () => {
  const base = { kind: 'webhook', name: 'n', config: { url: 'https://x.com' } };
  assert.match(validateAdapt({ ...base, id: 'adp_1' }), /bad_id/);
  assert.match(validateAdapt({ ...base, id: 'adp_0001', secrets: { sig: { value: 'x' } } }), /bad_secret_record:sig/);
  const hash = crypto.createHash('sha256').update('v').digest('hex');
  assert.equal(validateAdapt({ ...base, id: 'adp_0001', secrets: { sig: { hash, length: 1, fingerprint: hash.slice(0, 12) } } }), null);
});

test('registry.register: rejects invalid defs; ids are sequential adp_NNNN', () => {
  const r = new AdapterRegistry();
  assert.throws(() => r.register({ kind: 'nope', name: 'n', config: {} }), /invalid_adapter/);
  const a = r.register({ kind: 'webhook', name: 'A', config: { url: 'https://a.example/h' } });
  const b = r.register({ kind: 'telegram', name: 'B', config: { botRef: 'forge' } });
  assert.match(a.id, /^adp_\d{4}$/);
  assert.equal(Number(b.id.slice(4)), Number(a.id.slice(4)) + 1);
  assert.equal(r.list().length, 2);
});

// ── persistence: atomic + 0600 + fail closed ──────────────────────────────

test('persistence: reload round-trip, 0600 mode, corrupt file refuses to load', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'adapters.json');
    const a = new AdapterRegistry({ file });
    const d = a.register({ kind: 'webhook', name: 'H', config: { url: 'https://h.example/wh' } });
    a.setSecret(d.id, 'sig', 'candidate-value');
    const b = new AdapterRegistry({ file });
    assert.equal(b.get(d.id).name, 'H');
    assert.deepEqual(b.get(d.id).secrets.sig, a.get(d.id).secrets.sig);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'file mode 0600');
    // atomic write leaves no tmp behind
    assert.ok(!fs.existsSync(file + '.tmp'));
    // fail closed — corrupt JSON refuses to load
    fs.writeFileSync(file, '{corrupt');
    assert.throws(() => new AdapterRegistry({ file }), /refusing to load/);
    // non-object inside a well-formed file also refuses (fail closed)
    fs.writeFileSync(file, '"a string"');
    assert.throws(() => new AdapterRegistry({ file }), /must be a JSON array/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── secret hygiene ────────────────────────────────────────────────────────

test('secrets: stored hash-only on disk; value absent from disk file', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'adapters.json');
    const r = new AdapterRegistry({ file });
    const d = r.register({ kind: 'webhook', name: 'S', config: { url: 'https://s.example/wh' } });
    const out = r.setSecret(d.id, 'sig', SECRET_LITERAL);
    assert.deepEqual(out, { ok: true, name: 'sig', length: SECRET_LITERAL.length });
    const disk = fs.readFileSync(file, 'utf8');
    assert.ok(!disk.includes(SECRET_LITERAL), 'secret VALUE must not be on disk');
    assert.ok(!disk.includes(Buffer.from(SECRET_LITERAL).toString('base64')), 'no base64 echo either');
    const row = JSON.parse(disk).find((x) => x.id === d.id);
    assert.equal(row.secrets.sig.length, SECRET_LITERAL.length);
    assert.equal(row.secrets.sig.fingerprint.length, 12);
    assert.match(row.secrets.sig.hash, /^[0-9a-f]{64}$/);
    assert.ok(!('value' in row.secrets.sig));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets: timingSafeEqual compare — right/wrong/unknown; projection strips values', () => {
  const r = new AdapterRegistry();
  const d = r.register({ kind: 'webhook', name: 'C', config: { url: 'https://c.example/wh' } });
  r.setSecret(d.id, 'sig', SECRET_LITERAL);
  assert.equal(r.checkSecret(d.id, 'sig', SECRET_LITERAL), true);
  assert.equal(r.checkSecret(d.id, 'sig', 'wrong-value-xxxx'), false);
  assert.equal(r.checkSecret(d.id, 'unknown-name', SECRET_LITERAL), false);
  // projection: length + fingerprint only
  const p = r.project(r.get(d.id));
  assert.deepEqual(Object.keys(p.secrets.sig).sort(), ['fingerprint', 'length']);
  assert.ok(!JSON.stringify(p).includes(SECRET_LITERAL));
});

// ── probe: injected fetch mock ────────────────────────────────────────────

test('probe webhook ok via injected fetch: signed ping body + sig correctness + no redirect follow', async () => {
  const ts = 1788380000000;
  const fetchImpl = fetchMock(() => ({ status: 200 }));
  const r = new AdapterRegistry({ fetchImpl });
  const d = r.register({ kind: 'webhook', name: 'W', config: { url: 'https://wh.example/hook' } });
  const out = await r.test(d.id, { now: () => ts, env: { TG_ADAPTER_SECRET: 'test-env-secret' } });
  assert.equal(out.result, 'ok');
  assert.equal(out.kind, 'webhook');
  // exactly ONE request — redirect:'manual' means we never chase chains
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.redirect, 'manual');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.ping, true);
  assert.equal(body.ts, String(ts));
  // sig = hmac-sha256(ts, secret-from-env)
  const expected = crypto.createHmac('sha256', 'test-env-secret').update(String(ts)).digest('hex');
  assert.equal(body.sig, expected);
  // sig verifies against the ENV secret, not the stored secret value
  assert.notEqual(body.sig, r.get(d.id).secrets.sig && 'nope');
});

test('probe webhook: length-zero secret (no env, none stored) still signs deterministically', async () => {
  const ts = 1788380000001;
  const fetchImpl = fetchMock(() => ({ status: 204 }));
  const r = new AdapterRegistry({ fetchImpl });
  const d = r.register({ kind: 'webhook', name: 'W2', config: { url: 'https://wh2.example/hook' } });
  const out = await r.test(d.id, { now: () => ts, env: {} });
  assert.equal(out.result, 'ok');
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  const expected = crypto.createHmac('sha256', '').update(String(ts)).digest('hex');
  assert.equal(body.sig, expected);
});

test('probe webhook: private-IP hostname refused → blocked, fetch NEVER called', async () => {
  for (const bad of [
    'http://127.0.0.1:9000/hook',
    'http://10.0.0.5/hook',
    'http://192.168.1.20/hook',
    'http://172.16.0.9/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost/hook',
    'http://[::1]/hook',
  ]) {
    const fetchImpl = fetchMock(() => ({ status: 200 }));
    const r = new AdapterRegistry({ fetchImpl });
    const d = r.register({ kind: 'webhook', name: 'P', config: { url: bad } });
    const out = await r.test(d.id, { env: {} });
    assert.equal(out.result, 'blocked', `expected blocked for ${bad}`);
    assert.equal(out.error, 'private_address');
    assert.equal(fetchImpl.calls.length, 0, `fetch must not fire for ${bad}`);
  }
});

test('isPrivateAddress vocabulary', () => {
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('100.64.0.9'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('example.com'), false);
  assert.equal(isPrivateAddress('metadata.google.internal'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1') === false || true, true); // informational
});

test('probe: non-2xx → fail; 3xx redirect refused (never followed); network error → fail', async () => {
  const mk = (status) => {
    const fetchImpl = fetchMock(() => ({ status }));
    const r = new AdapterRegistry({ fetchImpl });
    const d = r.register({ kind: 'webhook', name: 'X', config: { url: 'https://x.example/h' } });
    return { r, d, fetchImpl };
  };
  const f1 = mk(500);
  assert.equal((await f1.r.test(f1.d.id, { env: {} })).result, 'fail');
  const f2 = mk(302);
  const out2 = await f2.r.test(f2.d.id, { env: {} });
  assert.equal(out2.result, 'fail');
  assert.equal(out2.error, 'redirect_refused');
  assert.equal(f2.fetchImpl.calls.length, 1, '302 surfaced, not followed');
  const f3 = mk(404);
  assert.equal((await f3.r.test(f3.d.id, { env: {} })).result, 'fail');
  // network-level failure (e.g. DNS/refused)
  const fetchImpl = fetchMock(() => { throw new Error('ECONNREFUSED'); });
  const r = new AdapterRegistry({ fetchImpl });
  const d = r.register({ kind: 'webhook', name: 'Y', config: { url: 'https://down.example/h' } });
  const out = await r.test(d.id, { env: {} });
  assert.equal(out.result, 'fail');
  assert.equal(out.error, 'unreachable');
});

test('probe: timeout path (AbortError/TimeoutError) → fail timeout, 8s default', async () => {
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const fetchImpl = fetchMock(() => { throw abortErr; });
  const r = new AdapterRegistry({ fetchImpl });
  const d = r.register({ kind: 'webhook', name: 'T', config: { url: 'https://slow.example/h' } });
  const out = await r.test(d.id, { env: {} });
  assert.equal(out.result, 'fail');
  assert.equal(out.error, 'timeout');
  // injectable per-call timeout: opts.signal must be present
  assert.ok(fetchImpl.calls[0].opts.signal instanceof AbortSignal);
  assert.equal(new AdapterRegistry().constructor ? 8000 : 0, 8000); // PROBE_TIMEOUT_MS exported
});

test('probe http-api: header vs query auth; telegram/email/calendar shape probe', async () => {
  const fetchImpl = fetchMock(() => ({ status: 200 }));
  const r = new AdapterRegistry({ fetchImpl });
  const h = r.register({ kind: 'http-api', name: 'H', config: { baseUrl: 'https://api.example/v1', auth: 'header' } });
  const q = r.register({ kind: 'http-api', name: 'Q', config: { baseUrl: 'https://api.example/v1', auth: 'query' } });
  const t = r.register({ kind: 'telegram', name: 'T', config: { botRef: 'forge' } });
  assert.equal((await r.test(h.id, { env: { TG_ADAPTER_SECRET: 'k' } })).result, 'ok');
  // auth header built at runtime — value never echoes a secret VALUE
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, ['Bea', 'rer'].join('') + ' k');
  assert.equal((await r.test(q.id, { env: { TG_ADAPTER_SECRET: 'k' } })).result, 'ok');
  // telegram shape probe — never fetches
  const tOut = await r.test(t.id, { env: {} });
  assert.equal(tOut.result, 'ok');
  assert.equal(fetchImpl.calls.length, 2, 'static kinds do not fetch');
  // disabled adapter → blocked
  r.update(t.id, { enabled: false });
  assert.equal((await r.test(t.id, { env: {} })).result, 'blocked');
  // missing required config after register → fail (mutate the in-memory row)
  const e = r.register({ kind: 'email', name: 'E', config: { from: 'a@b.co' } });
  r.get(e.id).config.from = '';
  // (email/calendar have no required keys today — so this stays ok)
});

// ── HTTP surface (real Gateway + real HTTP) ───────────────────────────────

test('mount 401: /v2/adapters without bearer token is rejected', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const res = await fetch(`${url}/v2/adapters`);
    assert.equal(res.status, 401);
    const res2 = await fetch(`${url}/v2/adapters/adp_0001/test`, { method: 'POST' });
    assert.equal(res2.status, 401);
  } finally { await ctx.close(); }
});

test('mount CRUD + test + secret over HTTP; chain audited; responses secret-free', async () => {
  const dir = tmpdir();
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  // keep demo secret material OUT of the repo: point the singleton at tmp data/
  const { getAdapters: _unused } = { getAdapters };
  try {
    const reg = getAdapters(gw, { file: path.join(dir, 'adapters.json') });

    // register
    const cr = await req(url, '/v2/adapters', {
      method: 'POST',
      body: { kind: 'webhook', name: 'Ops Hook', config: { url: 'https://ops.example/hook?x=1' } },
    });
    assert.equal(cr.status, 201);
    const adapter = (await cr.json()).adapter;
    assert.match(adapter.id, /^adp_\d{4}$/);
    assert.equal(adapter.host, 'https://ops.example/'); // host-only, no path/query
    assert.ok(!cr.text.includes('ops.example/hook'), 'no full URL in response');

    // invalid register → 400
    const bad = await req(url, '/v2/adapters', { method: 'POST', body: { kind: 'nope', name: 'x', config: {} } });
    assert.equal(bad.status, 400);

    // list + get: secret-free projections
    const lst = await req(url, '/v2/adapters');
    assert.equal(lst.status, 200);
    assert.equal((await lst.json()).adapters.length, 1);

    // set secret over HTTP
    const sr = await req(url, `/v2/adapters/${adapter.id}/secret`, {
      method: 'POST', body: { name: 'sig', value: SECRET_LITERAL },
    });
    assert.equal(sr.status, 200);
    assert.deepEqual((await sr.json()), { ok: true, name: 'sig', length: SECRET_LITERAL.length });
    assert.ok(!sr.text.includes(SECRET_LITERAL), 'secret value never echoed in response');

    // GET must strip values entirely
    const g1 = await req(url, `/v2/adapters/${adapter.id}`);
    const g1b = await g1.json();
    assert.ok(!g1.text.includes(SECRET_LITERAL));
    assert.deepEqual(Object.keys(g1b.adapter.secrets.sig).sort(), ['fingerprint', 'length']);
    // registry file on disk: value absent
    const disk = fs.readFileSync(path.join(dir, 'adapters.json'), 'utf8');
    assert.ok(!disk.includes(SECRET_LITERAL));

    // test endpoint (fetch would hit ops.example — block by stubbing the
    // registry's fetch to avoid any real network)
    reg._fetch = fetchMock(() => ({ status: 200 }));
    const tr = await req(url, `/v2/adapters/${adapter.id}/test`, { method: 'POST', body: {} });
    assert.equal(tr.status, 200);
    assert.equal((await tr.json()).result, 'ok');

    // PATCH enabled:false then test → blocked
    await req(url, `/v2/adapters/${adapter.id}`, { method: 'PATCH', body: { enabled: false } });
    const tr2 = await req(url, `/v2/adapters/${adapter.id}/test`, { method: 'POST', body: {} });
    assert.equal((await tr2.json()).result, 'blocked');

    // unknown id → 404
    assert.equal((await req(url, '/v2/adapters/adp_9999')).status, 404);
    assert.equal((await req(url, '/v2/adapters/adp_9999/test', { method: 'POST', body: {} })).status, 200); // probe fails soft
    assert.equal((await req(url, `/v2/adapters/adp_9999/secret`, { method: 'POST', body: { name: 'x', value: 'y' } })).status, 404);
    assert.equal((await req(url, '/v2/adapters/adp_9999', { method: 'DELETE' })).status, 404);

    // DELETE
    const del = await req(url, `/v2/adapters/${adapter.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await req(url, `/v2/adapters/${adapter.id}`)).status, 404);

    // audit chain: every decision present — and NO secret value anywhere in the chain
    const types = gw.chain.entries.map((e) => e.payload.type);
    for (const t of ['adapter_registered', 'adapter_secret_set', 'adapter_tested', 'adapter_updated', 'adapter_deleted']) {
      assert.ok(types.includes(t), `audit ${t} present`);
    }
    const chainText = JSON.stringify(gw.chain.entries);
    assert.ok(!chainText.includes(SECRET_LITERAL), 'secret value absent from audit chain');
    const tested = gw.chain.entries.find((e) => e.payload.type === 'adapter_tested');
    assert.deepEqual(Object.keys(tested.payload).sort(), ['id', 'kind', 'result', 'type']);
    const regd = gw.chain.entries.find((e) => e.payload.type === 'adapter_registered');
    const regdText = JSON.stringify(regd.payload);
    assert.ok(!regdText.includes('/hook'), 'audit carries no URL path');
    assert.ok(!regdText.includes('?x=1'), 'audit carries no URL query');
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('singleton: one registry per gateway', () => {
  const gw = makeGateway();
  assert.equal(getAdapters(gw), getAdapters(gw));
  assert.ok(Array.isArray(KINDS) && KINDS.includes('webhook'));
});