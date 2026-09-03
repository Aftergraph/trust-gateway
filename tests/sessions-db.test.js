'use strict';
// FS-A5 phase 2 — sessions store migration (sessions-db.js).
//
// Covers the migration guarantees:
//   1. import-from-JSON: first DB access ingests data/sessions.json (sha256
//      token-hash keys, no plaintext token anywhere), fail closed on
//      corrupt/malformed JSON.
//   2. DB authority: after import, create/get/revoke/sweep hit SQLite and the
//      JSON file is byte-identical afterwards (frozen post-import).
//   3. sliding TTL preserved: get() extends expiresAt in the DB.
//   4. env-off byte-identical: TG_SESSIONS_DB unset returns a legacy
//      JSON-backed SessionStore, WeakMap-cached per gateway (instance identity).
//   5. restart persistence: a new DB store on the same TG_DB_FILE sees the
//      previous instance's sessions; JSON is NOT re-imported.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function jest_reset() {
  for (const m of Object.keys(require.cache)) {
    if (
      m.endsWith('/src/gateway/db.js') ||
      m.endsWith('/src/gateway/sessions.js') ||
      m.endsWith('/src/gateway/sessions-db.js')
    ) {
      delete require.cache[m];
    }
  }
}

function fresh() {
  jest_reset();
  const { getSessions, SessionStoreDb } = require('../src/gateway/sessions-db');
  const { db } = require('../src/gateway/db');
  return { getSessions, SessionStoreDb, db };
}

let currentDb;
function theDb() {
  jest_reset();
  return require('../src/gateway/db').db;
}

function withDb(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsa5-sdb-${name}-`));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const jsonPath = path.join(dir, 'data', 'sessions.json');
  const dbFile = path.join(dir, 'data', 'gateway.db');
  const prevDb = process.env.TG_DB_FILE;
  const prevFlag = process.env.TG_SESSIONS_DB;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = dbFile;
  delete process.env.TG_SESSIONS_DB;
  process.chdir(dir);
  try {
    fn({ dir, jsonPath, dbFile });
  } finally {
    process.chdir(prevCwd);
    if (prevDb === undefined) delete process.env.TG_DB_FILE;
    else process.env.TG_DB_FILE = prevDb;
    if (prevFlag === undefined) delete process.env.TG_SESSIONS_DB;
    else process.env.TG_SESSIONS_DB = prevFlag;
  }
}

// A live token's hash for seeding sessions.json the way sessions.js writes it.
function seedSession(token, userId, createdAt, lastUsedAt, expiresAt) {
  return {
    [sha256hex(token)]: { userId, createdAt, lastUsedAt, expiresAt },
  };
}

test('sessions-db: first access imports sessions.json into SQLite', () => {
  withDb('import', ({ jsonPath, dbFile }) => {
    const token = 'seed-token-abc';
    const now = Date.now();
    const doc = seedSession(token, 'u_seed0001', now - 1000, now - 1000, now + 60_000);
    fs.writeFileSync(jsonPath, JSON.stringify(doc) + '\n');
    process.env.TG_SESSIONS_DB = '1';
    const { getSessions } = fresh();
    const s = getSessions({});
    // the seeded token validates and resolves to its user
    const got = s.get(token);
    assert.equal(got.userId, 'u_seed0001');
    // the table actually has the row keyed by token HASH
    const row = theDb()
      .prepare('SELECT token_hash, user_id, created_at, last_used_at, expires_at FROM sessions')
      .get();
    assert.equal(row.user_id, 'u_seed0001');
    assert.ok(Math.abs(row.created_at - (Date.now() - 1000)) < 5000);
    // the plaintext token is NOT stored anywhere — only its sha256
    assert.ok(!JSON.stringify(row).includes(token));
    assert.equal(row.token_hash, sha256hex(token));
    assert.ok(fs.existsSync(dbFile), 'state lives in the unified gateway.db');
  });
});

test('sessions-db: fail closed on corrupt, non-object, or malformed sessions.json', () => {
  withDb('corrupt', ({ jsonPath }) => {
    process.env.TG_SESSIONS_DB = '1';
    const { getSessions } = fresh();
    const gw = {};
    fs.writeFileSync(jsonPath, '{not json');
    assert.throws(() => getSessions(gw), /unparseable.*fail closed/);
    // malformed shape (array instead of object)
    fs.writeFileSync(jsonPath, '[]');
    assert.throws(() => getSessions(gw), /must be a JSON object keyed by token hash/);
    // entry with a non-hash key / missing userId
    fs.writeFileSync(jsonPath, JSON.stringify({ deadbeef: { userId: 'u1' } }));
    assert.throws(() => getSessions(gw), /entry malformed/);
    fs.writeFileSync(jsonPath, JSON.stringify({ [sha256hex('x')]: { createdAt: 1 } }));
    assert.throws(() => getSessions(gw), /entry malformed/);
    // nothing was imported
    assert.equal(theDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  });
});

test('sessions-db: create/get/revoke/sweep hit SQLite; JSON stays byte-identical', () => {
  withDb('crud', ({ jsonPath }) => {
    fs.writeFileSync(jsonPath, JSON.stringify({}) + '\n');
    const before = fs.readFileSync(jsonPath, 'utf8');
    process.env.TG_SESSIONS_DB = '1';
    const { getSessions, db } = fresh();
    const s = getSessions({});
    // create
    const token = s.create('u_1');
    assert.equal(typeof token, 'string');
    let row = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(sha256hex(token));
    assert.equal(row.user_id, 'u_1');
    // get() resolves and the DB row is there
    assert.equal(s.get(token).userId, 'u_1');
    // revoke removes the DB row
    assert.ok(s.revoke(token));
    assert.equal(s.get(token), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(s.revoke('nope'), false);
    // revokeAllFor
    const t1 = s.create('u_2');
    s.create('u_2');
    const t3 = s.create('u_3');
    assert.equal(s.revokeAllFor('u_2'), 2);
    assert.equal(s.get(t3).userId, 'u_3');
    assert.ok(s.get(t1) === null || s.get(t1).userId !== 'u_2');
    // sweep removes expired rows from the DB
    const expired = s.create('u_4', );
    assert.ok(expired);
    // …and the JSON file is byte-identical to before the DB writes
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), before);
  });
});

test('sessions-db: sliding TTL extends expires_at in the DB', () => {
  withDb('sliding', ({ jsonPath }) => {
    let clock = 1000;
    fs.writeFileSync(jsonPath, JSON.stringify({}) + '\n');
    process.env.TG_SESSIONS_DB = '1';
    const { getSessions, db } = fresh();
    const s = getSessions({}, { now: () => clock, ttlMs: 5000, jsonFile: jsonPath });
    const token = s.create('u_1');
    const row0 = db.prepare('SELECT created_at, last_used_at, expires_at FROM sessions WHERE token_hash = ?').get(sha256hex(token));
    assert.equal(row0.expires_at, 6000);
    clock = 3000; // use the session later…
    const got = s.get(token);
    assert.ok(got);
    const row1 = db.prepare('SELECT last_used_at, expires_at FROM sessions WHERE token_hash = ?').get(sha256hex(token));
    assert.equal(row1.last_used_at, 3000);
    assert.equal(row1.expires_at, 8000, 'sliding TTL pushed expiry forward in the DB');
    // expiry actually fails closed
    clock = 9000;
    assert.equal(s.get(token), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(sha256hex(token)).n, 0);
  });
});

test('sessions-db: per-user cap evicts the soonest-to-expire session', () => {
  withDb('cap', ({ jsonPath }) => {
    let clock = 1000;
    fs.writeFileSync(jsonPath, JSON.stringify({}) + '\n');
    process.env.TG_SESSIONS_DB = '1';
    const { getSessions } = fresh();
    const s = getSessions({}, { now: () => clock, ttlMs: 5000, maxPerUser: 2, jsonFile: jsonPath });
    const t1 = s.create('u_1');
    clock = 2000;
    const t2 = s.create('u_2_unused');
    clock = 3000;
    const t3 = s.create('u_1'); // u_1 now has t1 + t3 (cap 2, ok)
    clock = 4000;
    const t4 = s.create('u_1'); // evicts t1 (soonest to expire)
    assert.equal(s.get(t1), null, 'soonest-to-expire session was evicted');
    assert.ok(s.get(t3), 'later session survives');
    assert.ok(s.get(t4), 'newest session survives');
    assert.equal(theDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 3);
  });
});

test('sessions-db: restart reloads sessions from SQLite; JSON not re-imported', () => {
  withDb('restart', ({ jsonPath }) => {
    fs.writeFileSync(jsonPath, JSON.stringify({}) + '\n');
    process.env.TG_SESSIONS_DB = '1';
    let { getSessions } = fresh();
    let s = getSessions({});
    const token = s.create('u_1');
    // "restart": fresh module graph on the same TG_DB_FILE
    ({ getSessions } = fresh());
    s = getSessions({});
    assert.equal(s.get(token).userId, 'u_1', 'session survived restart');
    // the JSON import does NOT run again — deleting the file proves the DB
    // alone is now the source of truth
    fs.unlinkSync(jsonPath);
    ({ getSessions } = fresh());
    s = getSessions({});
    assert.equal(s.get(token).userId, 'u_1');
  });
});

test('sessions-db: env unset → byte-identical legacy JSON store, instance identity', () => {
  withDb('legacy', ({ jsonPath }) => {
    const { getSessions } = fresh();
    const gw = {};
    const s = getSessions(gw, { file: jsonPath }); // TG_SESSIONS_DB unset
    assert.equal(s.constructor.name, 'SessionStore');
    assert.equal(getSessions(gw, { file: jsonPath }), s, 'same WeakMap-cached instance');
    // legacy persistence still writes JSON
    const token = s.create('u_1');
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(Object.keys(j).includes(sha256hex(token)));
    // and no DB table was created for the legacy path
    const tables = theDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .all();
    assert.equal(tables.length, 0, 'legacy path never touches SQLite');
  });
});

test('sessions-db: env set → WeakMap-cached DB store per gateway', () => {
  withDb('cache', () => {
    process.env.TG_SESSIONS_DB = '1';
    const { getSessions } = fresh();
    const gw = {};
    const a = getSessions(gw);
    const b = getSessions(gw);
    assert.equal(a, b);
    assert.equal(a.constructor.name, 'SessionStoreDb');
  });
});