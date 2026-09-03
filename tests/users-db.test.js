'use strict';
// FS-A5 phase 2 — users store migration (users-db.js).
//
// Covers the migration guarantees:
//   1. import-from-JSON: first DB access ingests data/users.json (scrypt
//      hash + salt preserved verbatim), fail closed on corrupt/malformed/
//      duplicate-email JSON.
//   2. DB authority: after import, CRUD hits SQLite and the JSON file is
//      byte-identical afterwards (frozen post-import).
//   3. env-off byte-identical: TG_USERS_DB unset returns a legacy JSON-backed
//      UserStore, WeakMap-cached per gateway (instance identity).
//   4. restart persistence: a new DB store on the same TG_DB_FILE sees the
//      previous instance's mutations; JSON is NOT re-imported.
//   5. surface: project() still strips passwordHash/salt; verifyPassword works.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function jest_reset() {
  for (const m of Object.keys(require.cache)) {
    if (
      m.endsWith('/src/gateway/db.js') ||
      m.endsWith('/src/gateway/users.js') ||
      m.endsWith('/src/gateway/users-db.js')
    ) {
      delete require.cache[m];
    }
  }
}

function fresh() {
  jest_reset();
  const { getUsers, UserStoreDb } = require('../src/gateway/users-db');
  const { db } = require('../src/gateway/db');
  return { getUsers, UserStoreDb, db };
}

let currentDb;
function theDb() {
  jest_reset();
  return require('../src/gateway/db').db;
}

function withDb(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsa5-udb-${name}-`));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const jsonPath = path.join(dir, 'data', 'users.json');
  const dbFile = path.join(dir, 'data', 'gateway.db');
  const prevDb = process.env.TG_DB_FILE;
  const prevFlag = process.env.TG_USERS_DB;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = dbFile;
  delete process.env.TG_USERS_DB;
  process.chdir(dir);
  try {
    fn({ dir, jsonPath, dbFile });
  } finally {
    process.chdir(prevCwd);
    if (prevDb === undefined) delete process.env.TG_DB_FILE;
    else process.env.TG_DB_FILE = prevDb;
    if (prevFlag === undefined) delete process.env.TG_USERS_DB;
    else process.env.TG_USERS_DB = prevFlag;
  }
}

function writeJson(jsonPath, users) {
  fs.writeFileSync(jsonPath, JSON.stringify(users, null, 2) + '\n');
}

function seedUser(i) {
  return {
    id: `u_seed000${i}`,
    email: `user${i}@example.com`,
    passwordHash: 'a'.repeat(128),
    salt: 'b'.repeat(32),
    role: i === 0 ? 'owner' : 'member',
    display_name: `User ${i}`,
    created_at: new Date(1700000000000 + i).toISOString(),
    disabled: false,
  };
}

test('users-db: first access imports users.json into SQLite (hash+salt preserved)', () => {
  withDb('import', ({ jsonPath, dbFile }) => {
    const u = seedUser(0);
    writeJson(jsonPath, [u]);
    process.env.TG_USERS_DB = '1';
    const { getUsers } = fresh();
    const s = getUsers({});
    assert.equal(s.list().length, 1);
    const proj = s.list()[0];
    assert.equal(proj.email, u.email);
    assert.equal(proj.role, 'owner');
    assert.equal(proj.passwordHash, undefined, 'project never leaks the hash');
    assert.equal(proj.salt, undefined);
    // the table actually has the row, including the scrypt material
    const row = theDb()
      .prepare('SELECT id, email, password_hash, salt, role, display_name, created_at, disabled FROM users WHERE id = ?')
      .get(u.id);
    assert.equal(row.password_hash, u.passwordHash);
    assert.equal(row.salt, u.salt);
    assert.equal(row.role, 'owner');
    assert.equal(row.disabled, 0);
    assert.ok(fs.existsSync(dbFile), 'state lives in the unified gateway.db');
    // duplicate-email import fails closed even when the file was written first
  });
});

test('users-db: fail closed on corrupt, malformed, or duplicate-email users.json', () => {
  withDb('corrupt', ({ jsonPath }) => {
    process.env.TG_USERS_DB = '1';
    const { getUsers } = fresh();
    const gw = {};
    fs.writeFileSync(jsonPath, '{not json');
    assert.throws(() => getUsers(gw), /unparseable.*fail closed/);
    // malformed shape
    fs.writeFileSync(jsonPath, '{"nope": true}');
    assert.throws(() => getUsers(gw), /must be a JSON array/);
    // entry missing passwordHash
    writeJson(jsonPath, [{ id: 'u_x', email: 'x@y.z' }]);
    assert.throws(() => getUsers(gw), /missing id\/email\/passwordHash/);
    // duplicate email
    const a = seedUser(1);
    const b = { ...seedUser(2), email: a.email };
    writeJson(jsonPath, [a, b]);
    assert.throws(() => getUsers(gw), /duplicate email/);
    // and nothing was imported — the table stays empty
    assert.equal(theDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  });
});

test('users-db: CRUD hits SQLite and the JSON file stays byte-identical', () => {
  withDb('crud', ({ jsonPath }) => {
    writeJson(jsonPath, [seedUser(0)]);
    const before = fs.readFileSync(jsonPath, 'utf8');
    process.env.TG_USERS_DB = '1';
    const { getUsers, db } = fresh();
    const s = getUsers({});
    // create
    const out = s.create({ email: 'new@example.com', password: 'long-enough-pw' });
    assert.ok(out.ok);
    const id = out.user.id;
    // DB row exists…
    let row = db.prepare('SELECT email, role FROM users WHERE id = ?').get(id);
    assert.equal(row.email, 'new@example.com');
    assert.equal(row.role, 'member', 'second user is a member');
    // update paths
    assert.ok(s.setRole(id, 'operator').ok);
    assert.ok(s.setDisabled(id, true).ok);
    assert.ok(s.setPassword(id, 'another-long-pw').ok);
    row = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(id);
    assert.equal(row.role, 'operator');
    assert.equal(row.disabled, 1);
    // password actually verifies from the DB-loaded record
    assert.ok(s.verifyPassword(s.getById(id), 'another-long-pw'));
    // lookup paths intact
    assert.equal(s.getByEmail('new@example.com').id, id);
    assert.equal(s.getByEmail('NEW@Example.COM').id, id, 'email lookup is case-normalised');
    assert.equal(s.getByEmail('nobody@example.com'), null);
    // …and the JSON file is byte-identical to before the DB writes
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), before);
  });
});

test('users-db: weak passwords and duplicate emails are still rejected', () => {
  withDb('validation', ({ jsonPath }) => {
    writeJson(jsonPath, [seedUser(0)]);
    process.env.TG_USERS_DB = '1';
    const { getUsers } = fresh();
    const s = getUsers({});
    assert.deepEqual(s.create({ email: 'a@b.co', password: 'short' }), { ok: false, error: 'weak_password' });
    assert.deepEqual(s.create({ email: 'user0@example.com', password: 'long-enough-pw' }), { ok: false, error: 'email_taken' });
    assert.deepEqual(s.create({ email: 'not-an-email', password: 'long-enough-pw' }), { ok: false, error: 'invalid_email' });
    assert.equal(theDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  });
});

test('users-db: restart reloads from SQLite; JSON not re-imported', () => {
  withDb('restart', ({ jsonPath }) => {
    writeJson(jsonPath, [seedUser(0)]);
    process.env.TG_USERS_DB = '1';
    let { getUsers } = fresh();
    let s = getUsers({});
    const out = s.create({ email: 'restart@example.com', password: 'long-enough-pw' });
    assert.ok(out.ok);
    const created = out.user;
    // "restart": fresh module graph on the same TG_DB_FILE
    ({ getUsers } = fresh());
    s = getUsers({});
    assert.ok(s.getByEmail('restart@example.com'), 'created user survived restart');
    assert.equal(s.getByEmail(created.email).id, created.id);
    assert.ok(s.verifyPassword(s.getByEmail('restart@example.com'), 'long-enough-pw'));
    // the JSON import does NOT run again — deleting the file proves the DB
    // alone is now the source of truth
    fs.unlinkSync(jsonPath);
    ({ getUsers } = fresh());
    s = getUsers({});
    assert.ok(s.getByEmail('restart@example.com'));
    assert.equal(s.list().length, 2);
  });
});

test('users-db: env unset → byte-identical legacy JSON store, instance identity', () => {
  withDb('legacy', ({ jsonPath }) => {
    const { getUsers } = fresh();
    const gw = {};
    const s = getUsers(gw, { file: jsonPath }); // TG_USERS_DB unset
    assert.equal(s.constructor.name, 'UserStore');
    assert.equal(getUsers(gw, { file: jsonPath }), s, 'same WeakMap-cached instance');
    // legacy persistence still writes JSON
    const out = s.create({ email: 'legacy@example.com', password: 'long-enough-pw' });
    assert.ok(out.ok);
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(j.some((u) => u.email === 'legacy@example.com'));
    // and no DB table was created for the legacy path
    const tables = theDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    assert.equal(tables.length, 0, 'legacy path never touches SQLite');
  });
});

test('users-db: env set → WeakMap-cached DB store per gateway', () => {
  withDb('cache', () => {
    process.env.TG_USERS_DB = '1';
    const { getUsers } = fresh();
    const gw = {};
    const a = getUsers(gw);
    const b = getUsers(gw);
    assert.equal(a, b);
    assert.equal(a.constructor.name, 'UserStoreDb');
  });
});

test('users-db: empty store (no JSON) works — fresh install on SQLite', () => {
  withDb('fresh', ({ jsonPath }) => {
    process.env.TG_USERS_DB = '1';
    const { getUsers } = fresh();
    const s = getUsers({ jsonFile: jsonPath });
    assert.equal(s.list().length, 0);
    const out = s.create({ email: 'first@example.com', password: 'long-enough-pw' });
    assert.ok(out.ok);
    assert.equal(out.user.role, 'owner', 'first user on a fresh DB owns the instance');
  });
});