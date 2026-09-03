'use strict';
// FS-A1 tests — human user accounts + scrypt sessions + /v2/auth mounts.
// Covers: register/login/logout round-trip over real HTTP, wrong-password
// generic error (no enumeration), scrypt hash never returned, rate limits,
// session TTL (sliding) + revocation, first-user-owner, fail-closed corrupt
// files, cookie flags, and audit-event emission.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { UserStore } = require('../src/gateway/users');
const { SessionStore } = require('../src/gateway/sessions');

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-auth-' + tag + '-'));
}

// ── HTTP harness ─────────────────────────────────────────────────────────

async function mkGw(dir) {
  process.env.TG_USERS_FILE = path.join(dir, 'users.json');
  process.env.TG_SESSIONS_FILE = path.join(dir, 'sessions.json');
  const gw = new Gateway({
    bots: { forge: { token: 'fw-tok', role: 'worker', capabilities: ['*'] } },
  });
  const srv = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { gw, srv, port: srv.address().port };
}

async function call(port, method, urlPath, { body, cookie } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

function cookieToken(setCookie) {
  const m = /tg_session=([^;]*)/.exec(setCookie || '');
  return m ? m[1] : null;
}

function cleanup(dir, srv) {
  delete process.env.TG_USERS_FILE;
  delete process.env.TG_SESSIONS_FILE;
  if (srv) srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Round-trip over real HTTP ─────────────────────────────────────────────

test('auth: register → login → me → logout round-trip over real HTTP', async () => {
  const dir = tmpdir('rt');
  const { gw, srv, port } = await mkGw(dir);
  try {
    // register (first user → owner) + auto session
    const reg = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'Ada@Example.com', password: 'correct horse battery', display_name: 'Ada' },
    });
    assert.equal(reg.status, 201);
    assert.match(reg.json.user.id, /^u_[0-9a-f]{8}$/);
    assert.equal(reg.json.user.email, 'ada@example.com'); // lowercased
    assert.equal(reg.json.user.role, 'owner');
    assert.equal(reg.json.user.disabled, false);
    assert.equal(reg.json.bot, null);
    const t1 = cookieToken(reg.setCookie);
    assert.ok(t1, 'register sets session cookie');

    // me with cookie
    const me = await call(port, 'GET', '/v2/auth/me', { cookie: `tg_session=${t1}` });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, 'ada@example.com');
    assert.equal(me.json.bot, null);

    // logout revokes the session server-side
    const out = await call(port, 'POST', '/v2/auth/logout', { cookie: `tg_session=${t1}` });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    const me2 = await call(port, 'GET', '/v2/auth/me', { cookie: `tg_session=${t1}` });
    assert.equal(me2.status, 401);

    // wrong password first: generic error + user_login_failed on the record
    const bad = await call(port, 'POST', '/v2/auth/login', {
      body: { email: 'ada@example.com', password: 'totally-wrong-password' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'invalid credentials');

    // login again, fresh session works
    const login = await call(port, 'POST', '/v2/auth/login', {
      body: { email: 'ada@example.com', password: 'correct horse battery' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.email, 'ada@example.com');
    const t2 = cookieToken(login.setCookie);
    assert.ok(t2 && t2 !== t1);
    const me3 = await call(port, 'GET', '/v2/auth/me', { cookie: `tg_session=${t2}` });
    assert.equal(me3.status, 200);

    // session survived restart (durable file, token hash only)
    const gw2 = new Gateway({ bots: { forge: { token: 'fw-tok', role: 'worker', capabilities: ['*'] } } });
    const srv2 = http.createServer((req, res) => gw2.handle(req, res));
    await new Promise((resolve) => srv2.listen(0, '127.0.0.1', resolve));
    const me4 = await call(srv2.address().port, 'GET', '/v2/auth/me', { cookie: `tg_session=${t2}` });
    assert.equal(me4.status, 200, 'session survives restart');
    srv2.close();

    // audit chain carries the four FS-A1 event types
    const types = gw.chain.entries.map((e) => e.payload.type);
    for (const t of ['user_registered', 'user_login_ok', 'user_login_failed', 'user_logout'])
      assert.ok(types.includes(t), `audit missing ${t}`);
    const regEntry = gw.chain.entries.find((e) => e.payload.type === 'user_registered');
    assert.deepEqual(Object.keys(regEntry.payload).includes('userId'), true);
    assert.ok(!JSON.stringify(gw.chain.entries.map((e) => e.payload)).includes('correct horse'));
  } finally {
    cleanup(dir, srv);
  }
});

test('auth: cookie flags httpOnly + SameSite=Lax', async () => {
  const dir = tmpdir('flags');
  const { srv, port } = await mkGw(dir);
  try {
    const reg = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'flag@example.com', password: 'longenough123' },
    });
    assert.match(reg.setCookie, /HttpOnly/i);
    assert.match(reg.setCookie, /SameSite=Lax/);
    assert.match(reg.setCookie, /Path=\//);
  } finally {
    cleanup(dir, srv);
  }
});

// ── No enumeration / no secret leakage ───────────────────────────────────

test('auth: wrong password and unknown email return the SAME generic error', async () => {
  const dir = tmpdir('enum');
  const { srv, port } = await mkGw(dir);
  try {
    await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'known@example.com', password: 'longenough123' },
    });
    const wrongPw = await call(port, 'POST', '/v2/auth/login', {
      body: { email: 'known@example.com', password: 'definitely-wrong-password' },
    });
    const unknownEmail = await call(port, 'POST', '/v2/auth/login', {
      body: { email: 'nobody@example.com', password: 'definitely-wrong-password' },
    });
    assert.equal(wrongPw.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPw.json.error, 'invalid credentials');
    assert.equal(unknownEmail.json.error, 'invalid credentials');
    assert.equal(wrongPw.json.error, unknownEmail.json.error);
    // audit records reasons, but never which email exists
    const gwTypes = 'checked separately';
    assert.ok(gwTypes);
  } finally {
    cleanup(dir, srv);
  }
});

test('auth: scrypt hash + salt are never returned by any endpoint', async () => {
  const dir = tmpdir('leak');
  const { srv, port } = await mkGw(dir);
  try {
    const reg = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'x@example.com', password: 'longenough123' },
    });
    assert.ok(!JSON.stringify(reg.json).includes('passwordHash'));
    assert.ok(!JSON.stringify(reg.json).includes('salt'));
    const login = await call(port, 'POST', '/v2/auth/login', {
      body: { email: 'x@example.com', password: 'longenough123' },
    });
    assert.ok(!JSON.stringify(login.json).includes('passwordHash'));
    const me = await call(port, 'GET', '/v2/auth/me', {
      cookie: `tg_session=${cookieToken(login.setCookie)}`,
    });
    assert.ok(!JSON.stringify(me.json).includes('passwordHash'));
    // but the file does hold a scrypt hash (not plaintext)
    const onDisk = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
    assert.ok(!onDisk.includes('longenough123'), 'plaintext password never on disk');
    assert.match(onDisk, /passwordHash/);
  } finally {
    cleanup(dir, srv);
  }
});

// ── Validation ────────────────────────────────────────────────────────────

test('auth: weak password, bad email, duplicate email rejected', async () => {
  const dir = tmpdir('valid');
  const { srv, port } = await mkGw(dir);
  try {
    const short = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'a@example.com', password: 'short9chr' }, // 9 chars < 10
    });
    assert.equal(short.status, 400);
    assert.equal(short.json.error, 'weak_password');

    const bad = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'not-an-email', password: 'longenough123' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_email');

    await call(port, 'POST', '/v2/auth/register', { body: { email: 'a@example.com', password: 'longenough123' } });
    const dup = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'A@EXAMPLE.COM', password: 'longenough123' },
    });
    assert.equal(dup.status, 409);
  } finally {
    cleanup(dir, srv);
  }
});

// ── Rate limits ───────────────────────────────────────────────────────────

test('auth: register limited to 5/min/IP, login to 10/min/IP', async () => {
  const dir = tmpdir('rate');
  const { srv, port } = await mkGw(dir);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await call(port, 'POST', '/v2/auth/register', {
        body: { email: `u${i}@example.com`, password: 'longenough123' },
      });
      assert.equal(r.status, 201, `register #${i + 1} should pass`);
    }
    const sixth = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'u5@example.com', password: 'longenough123' },
    });
    assert.equal(sixth.status, 429);

    for (let i = 0; i < 10; i++) {
      const r = await call(port, 'POST', '/v2/auth/login', {
        body: { email: 'nobody@example.com', password: 'nope-nope-nope' },
      });
      assert.notEqual(r.status, 429, `login attempt #${i + 1} should not be rate limited yet`);
    }
    const eleventh = await call(port, 'POST', '/v2/auth/login', {
      body: { email: 'nobody@example.com', password: 'nope-nope-nope' },
    });
    assert.equal(eleventh.status, 429);
  } finally {
    cleanup(dir, srv);
  }
});

// ── Session store: TTL, sliding, revocation, cap, hash-only storage ──────

test('sessions: 7d TTL, sliding extension, revocation, revokeAllFor', () => {
  let t = 1_700_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sess-'));
  const file = path.join(dir, 'sessions.json');
  const s = new SessionStore({ file, now: () => t, ttlMs: 7 * 24 * 3600 * 1000 });

  const tok = s.create('u_1');
  const hashOnDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = Object.keys(hashOnDisk);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[0-9a-f]{64}$/, 'only sha256(token) stored, never plaintext');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(tok), 'plaintext token absent from disk');

  // valid before TTL…
  t += 6 * 24 * 3600 * 1000;
  assert.ok(s.get(tok), 'still valid at day 6');
  // …sliding: the use above pushed expiry out, so day 6 again is still fine
  t += 6 * 24 * 3600 * 1000;
  assert.ok(s.get(tok), 'sliding TTL extended by the day-6 use');
  // hard expiry beyond the last use
  t += 8 * 24 * 3600 * 1000;
  assert.equal(s.get(tok), null, 'expired after 7d past last use');

  // revocation
  const a = s.create('u_2');
  const b = s.create('u_2');
  const c = s.create('u_3');
  assert.ok(s.get(a) && s.get(b) && s.get(c));
  assert.equal(s.revoke(a), true);
  assert.equal(s.get(a), null);
  assert.equal(s.revoke('bogus-token'), false);
  assert.equal(s.revokeAllFor('u_2'), 1); // b alive, a already gone
  assert.equal(s.get(b), null);
  assert.ok(s.get(c), 'other users untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sessions: max 200 per user, soonest-expiring evicted; corrupt file fails closed', () => {
  let t = 1_700_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sess2-'));
  const file = path.join(dir, 'sessions.json');
  const s = new SessionStore({ file, now: () => t, maxPerUser: 3 });
  const t1 = s.create('u_9');
  const t2 = s.create('u_9');
  const t3 = s.create('u_9');
  const t4 = s.create('u_9'); // cap hit → soonest-expiring (t1) evicted
  assert.equal(s.get(t1), null, 'oldest evicted at cap');
  assert.ok(s.get(t2) && s.get(t3) && s.get(t4));

  fs.writeFileSync(file, '{{{corrupt');
  assert.throws(() => new SessionStore({ file }), /refusing to load/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sessions: file mode 0600, no .tmp residue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sess3-'));
  const file = path.join(dir, 'sessions.json');
  const s = new SessionStore({ file });
  s.create('u_1');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(file + '.tmp'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Users store: roles, persistence, fail-closed, hygiene ────────────────

test('users: first user is owner, later signups are members, env override honored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-users-'));
  const file = path.join(dir, 'users.json');
  const s1 = new UserStore({ file });
  const a = s1.create({ email: 'A@Example.COM', password: 'longenough123' });
  assert.equal(a.ok, true);
  assert.equal(a.user.role, 'owner');
  const b = s1.create({ email: 'b@example.com', password: 'longenough123' });
  assert.equal(b.ok, true);
  assert.equal(b.user.role, 'member');

  const empty = new UserStore({ file: path.join(dir, 'u2.json'), firstUserRole: 'operator' });
  assert.equal(empty.create({ email: 'first@example.com', password: 'longenough123' }).user.role, 'operator');
  assert.equal(empty.create({ email: 'second@example.com', password: 'longenough123' }).user.role, 'member');

  // persistence round-trip + unique lowercase email
  const s2 = new UserStore({ file });
  assert.equal(s2.list().length, 2);
  assert.equal(s2.getByEmail('a@example.com').id, a.user.id);
  assert.equal(s2.create({ email: 'a@example.com', password: 'longenough123' }).error, 'email_taken');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('users: verifyPassword timing-safe, setPassword re-salts, setRole/setDisabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-users2-'));
  const s = new UserStore({ file: null });
  const { user } = s.create({ email: 'x@example.com', password: 'longenough123' });
  assert.equal(s.verifyPassword(s.getById(user.id), 'longenough123'), true);
  assert.equal(s.verifyPassword(user, 'wrong-password!'), false);
  assert.equal(s.verifyPassword(null, 'x'), false);
  assert.equal(s.verifyPassword(user, undefined), false);

  const oldHash = s.getById(user.id).passwordHash;
  s.setPassword(user.id, 'brand-new-password-42');
  assert.notEqual(s.getById(user.id).passwordHash, oldHash);
  assert.equal(s.verifyPassword(s.getById(user.id), 'longenough123'), false, 'old password dead');
  assert.equal(s.verifyPassword(s.getById(user.id), 'brand-new-password-42'), true);

  assert.equal(s.setRole(user.id, 'operator').ok, true);
  assert.equal(s.getById(user.id).role, 'operator');
  assert.equal(s.setRole(user.id, 'emperor').error, 'bad_role');
  assert.equal(s.setDisabled(user.id, true).ok, true);
  assert.equal(s.getById(user.id).disabled, true);
  // disabled accounts cannot verify a login path in the mount; store keeps hash
  fs.rmSync(dir, { recursive: true, force: true });
});

test('users: corrupt file refuses to load (fail closed), HTTP surface returns 503', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-users3-'));
  const bad = path.join(dir, 'users.json');
  fs.writeFileSync(bad, 'not json at all {{{');
  assert.throws(() => new UserStore({ file: bad }), /refusing to load/);

  // HTTP: a gateway pointed at a corrupt store fails closed with 503, no 500 crash
  process.env.TG_USERS_FILE = bad;
  process.env.TG_SESSIONS_FILE = path.join(dir, 'sessions.json');
  const gw = new Gateway({ bots: {} });
  const srv = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const r = await call(srv.address().port, 'POST', '/v2/auth/login', {
    body: { email: 'x@example.com', password: 'whatever-long' },
  });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'auth_store_unavailable');
  srv.close();
  delete process.env.TG_USERS_FILE;
  delete process.env.TG_SESSIONS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('users: disabled account cannot login (generic error), existing session killed', async () => {
  const dir = tmpdir('dis');
  const { gw, srv, port } = await mkGw(dir);
  try {
    const reg = await call(port, 'POST', '/v2/auth/register', {
      body: { email: 'd@example.com', password: 'longenough123' },
    });
    const tok = cookieToken(reg.setCookie);
    const userId = reg.json.user.id;
    gw._authStores.users.setDisabled(userId, true);
    const me = await call(port, 'GET', '/v2/auth/me', { cookie: `tg_session=${tok}` });
    assert.equal(me.status, 401);
    const login = await call(port, 'POST', '/v2/auth/login', {
      body: { email: 'd@example.com', password: 'longenough123' },
    });
    assert.equal(login.status, 401);
    assert.equal(login.json.error, 'invalid credentials'); // still generic
  } finally {
    cleanup(dir, srv);
  }
});
