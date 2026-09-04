'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-approval-storage-'));
}

function node(code, env = {}) {
  return execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createLegacyDb(dbFile, row) {
  node(`
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbFile)});
    db.exec(${JSON.stringify(`
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, bot TEXT, tool TEXT, args_json TEXT,
        status TEXT NOT NULL, requested_by TEXT, resolved_by TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER,
        args_summary_json TEXT, reason TEXT, expires_at INTEGER,
        impact_json TEXT
      );
    `)});
    db.prepare(
      'INSERT INTO approvals(id, bot, tool, args_json, status, requested_by, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(${JSON.stringify(row.id)}, ${JSON.stringify(row.bot)}, ${JSON.stringify(row.tool)},
      ${JSON.stringify(JSON.stringify(row.args))}, 'pending', ${JSON.stringify(row.bot)},
      ${row.createdAt}, ${row.expiresAt});
    db.close();
  `, { TG_DB_FILE: dbFile });
}

test('migrates a legacy SQLite approvals table and reloads action identity in a fresh process', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'gateway.db');
  const legacy = { id: 'apr_000007', bot: 'worker', tool: 'shell.run', args: { command: 'echo legacy' }, createdAt: Date.now(), expiresAt: Date.now() + 60000 };
  createLegacyDb(dbFile, legacy);

  const first = JSON.parse(node(`
    const { ApprovalStoreDb } = require('./src/gateway/approvals-db');
    const store = new ApprovalStoreDb({ table: 'approvals', jsonFile: ${JSON.stringify(path.join(dir, 'missing.json'))} });
    const old = store.get('apr_000007');
    const added = store.request({ bot: { name: 'operator' }, tool: 'fs.write', args: { path: '/tmp/x' }, reason: 'bound', action_id: 'aie-action-7' });
    const db = require('./src/gateway/db').db;
    const columns = db.prepare('PRAGMA table_info(approvals)').all().map((c) => c.name);
    console.log(JSON.stringify({ old, added, columns }));
  `, { TG_DB_FILE: dbFile }));
  assert.equal(first.old.action_id, null);
  assert.equal(first.old.bot, legacy.bot);
  assert.deepEqual(first.old.args, legacy.args);
  assert.equal(first.added.action_id, 'aie-action-7');
  assert.ok(first.columns.includes('action_id'));

  const reloaded = JSON.parse(node(`
    const { ApprovalStoreDb } = require('./src/gateway/approvals-db');
    const store = new ApprovalStoreDb({ table: 'approvals', jsonFile: ${JSON.stringify(path.join(dir, 'missing.json'))} });
    console.log(JSON.stringify({ old: store.get('apr_000007'), added: store.get('apr_000008') }));
  `, { TG_DB_FILE: dbFile }));
  assert.equal(reloaded.old.action_id, null);
  assert.equal(reloaded.old.bot, 'worker');
  assert.deepEqual(reloaded.old.args, legacy.args);
  assert.equal(reloaded.added.action_id, 'aie-action-7');
  assert.equal(reloaded.added.bot, 'operator');
  assert.deepEqual(reloaded.added.args, { path: '/tmp/x' });
});

test('imports JSON action_id and persists it through a fresh SQLite process', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'gateway.db');
  const jsonFile = path.join(dir, 'approvals.json');
  const row = {
    id: 'apr_000003', action_id: 'json-action-3', bot: 'worker', tool: 'shell.run',
    args: { command: 'echo json' }, argsSummary: '{"command":"echo json"}',
    reason: 'import', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60000,
    resolvedBy: null, resolvedAt: null, impact: { risk: 'destructive' },
  };
  fs.writeFileSync(jsonFile, JSON.stringify([row]));
  const result = JSON.parse(node(`
    const { ApprovalStoreDb } = require('./src/gateway/approvals-db');
    const store = new ApprovalStoreDb({ jsonFile: ${JSON.stringify(jsonFile)} });
    console.log(JSON.stringify(store.get('apr_000003')));
  `, { TG_DB_FILE: dbFile }));
  assert.equal(result.action_id, 'json-action-3');
  assert.equal(result.bot, 'worker');
  assert.deepEqual(result.args, row.args);

  const reloaded = JSON.parse(node(`
    const { ApprovalStoreDb } = require('./src/gateway/approvals-db');
    console.log(JSON.stringify(new ApprovalStoreDb({ jsonFile: ${JSON.stringify(jsonFile)} }).get('apr_000003')));
  `, { TG_DB_FILE: dbFile }));
  assert.equal(reloaded.action_id, 'json-action-3');
  assert.deepEqual(reloaded.args, row.args);
});
