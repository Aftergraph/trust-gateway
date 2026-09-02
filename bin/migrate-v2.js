#!/usr/bin/env node
'use strict';
// Trust Gateway v2 — fail-closed migration: JSONL + approvals.json → gateway.db (node:sqlite).
//
// Idempotent + strict: refuses to import unless the resulting SQL chain verifies
// AND its head hash matches the JSONL head hash AND its length matches the JSONL
// line count. On any integrity mismatch the partially-built db file is removed
// and the process exits non-zero.

const fs = require('node:fs');
const path = require('node:path');
const { SqlChain } = require('../src/gateway/sql-chain');
const { entryHash } = require('../src/gateway/hash-chain');

function parseArgs(argv) {
  const out = {
    jsonl: null,
    approvals: null,
    db: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jsonl') out.jsonl = argv[++i];
    else if (a === '--approvals') out.approvals = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: node bin/migrate-v2.js [--jsonl PATH] [--approvals PATH] [--db PATH] [--force]\n' +
          '  Defaults: --jsonl data/audit.jsonl  --approvals data/approvals.json  --db data/gateway.db\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`migrate-v2: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  const root = process.cwd();
  if (!out.jsonl) out.jsonl = path.join(root, 'data', 'audit.jsonl');
  if (!out.approvals) out.approvals = path.join(root, 'data', 'approvals.json');
  if (!out.db) out.db = path.join(root, 'data', 'gateway.db');
  return out;
}

// Read the JSONL into memory, parse every non-empty line.
function readJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`migrate-v2: unparseable line ${i + 1} in ${file}: ${e.message}`);
    }
    out.push(parsed);
  }
  return out;
}

function readApprovals(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`migrate-v2: unparseable approvals file ${file}: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`migrate-v2: approvals file ${file} is not a JSON array`);
  }
  return parsed;
}

function wipeDbArtifacts(dbFile) {
  for (const p of [dbFile, dbFile + '-wal', dbFile + '-shm', dbFile + '-journal']) {
    try { fs.unlinkSync(p); } catch { /* file may not exist */ }
  }
}

function ensureApprovalsTable(chain) {
  chain.db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      bot TEXT,
      tool TEXT,
      args TEXT,
      status TEXT,
      created_at INT,
      expires_at INT,
      resolved_by TEXT,
      resolved_at INT
    );
  `);
}

function importApprovals(chain, rows) {
  if (rows.length === 0) return 0;
  const stmt = chain.db.prepare(
    `INSERT OR REPLACE INTO approvals
       (id, bot, tool, args, status, created_at, expires_at, resolved_by, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = chain.db.prepare('BEGIN');
  const commit = chain.db.prepare('COMMIT');
  const rollback = chain.db.prepare('ROLLBACK');
  tx.run();
  try {
    for (const r of rows) {
      const argsField =
        r.args === undefined || r.args === null
          ? (r.argsSummary ?? null)
          : (typeof r.args === 'string' ? r.args : JSON.stringify(r.args));
      stmt.run(
        String(r.id),
        r.bot ?? null,
        r.tool ?? null,
        argsField,
        r.status ?? null,
        r.createdAt ?? r.created_at ?? null,
        r.expiresAt ?? r.expires_at ?? null,
        r.resolvedBy ?? r.resolved_by ?? null,
        r.resolvedAt ?? r.resolved_at ?? null
      );
    }
    commit.run();
  } catch (e) {
    try { rollback.run(); } catch { /* ignore */ }
    throw e;
  }
  return rows.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.jsonl)) {
    process.stderr.write(`migrate-v2: audit jsonl not found: ${args.jsonl}\n`);
    process.exit(2);
  }
  const jsonlEntries = readJsonl(args.jsonl);
  if (jsonlEntries.length === 0) {
    process.stderr.write(`migrate-v2: empty audit jsonl: ${args.jsonl}\n`);
    process.exit(2);
  }

  // Idempotency: if the db already exists with the same chainId and the same
  // head hash and the same length as the JSONL, treat as up-to-date.
  if (fs.existsSync(args.db) && !args.force) {
    try {
      const probe = new SqlChain({ file: args.db });
      const v = probe.verify();
      probe.close();
      const jsonlHead = jsonlEntries[jsonlEntries.length - 1];
      if (
        v.ok &&
        v.length === jsonlEntries.length &&
        v.head === jsonlHead.hash &&
        v.chainId === (jsonlEntries[0].payload && jsonlEntries[0].payload.chainId)
      ) {
        process.stdout.write(
          JSON.stringify({
            skipped: true,
            already: 'up-to-date',
            entries: v.length,
            head: v.head,
            chainId: v.chainId,
          }) + '\n'
        );
        return;
      }
    } catch {
      // Probe failed (corrupt db) — fall through to fresh migration.
    }
  }

  // Fresh migration — ensure clean slate.
  wipeDbArtifacts(args.db);

  const chain = new SqlChain({ file: args.db });

  // If the JSONL already contains a genesis entry (seq 0, type 'genesis'),
  // we MUST preserve it. We can't naively append a new genesis.
  const hasGenesis = jsonlEntries[0] && jsonlEntries[0].seq === 0
    && jsonlEntries[0].payload && jsonlEntries[0].payload.type === 'genesis';

  if (hasGenesis) {
    // Wipe the auto-created genesis and re-insert the JSONL genesis + the rest.
    chain.db.exec('DELETE FROM chain_entries');
    const insert = chain.db.prepare(
      'INSERT INTO chain_entries(seq, ts, prev_hash, hash, payload) VALUES(?,?,?,?,?)'
    );
    const tx = chain.db.prepare('BEGIN');
    const commit = chain.db.prepare('COMMIT');
    const rollback = chain.db.prepare('ROLLBACK');
    tx.run();
    try {
      for (const e of jsonlEntries) {
        // Verify each entry's hash matches the payload we are about to insert.
        const expected = entryHash(e.seq, e.prevHash, e.ts, e.payload);
        if (expected !== e.hash) {
          throw new Error(
            `migrate-v2: hash mismatch at seq ${e.seq}: expected ${expected} got ${e.hash}`
          );
        }
        insert.run(e.seq, e.ts, e.prevHash, e.hash, JSON.stringify(e.payload));
      }
      // Sync chain_meta.chainId from genesis payload.
      chain.db
        .prepare('INSERT OR REPLACE INTO chain_meta(k, v) VALUES(?, ?)')
        .run('chainId', jsonlEntries[0].payload.chainId);
      commit.run();
    } catch (e) {
      try { rollback.run(); } catch { /* ignore */ }
      chain.close();
      wipeDbArtifacts(args.db);
      process.stderr.write(`migrate-v2: ${e.message}\n`);
      process.exit(1);
    }
    // Reload chainId into the in-memory property (the constructor's
    // _loadChainId() only ran against the auto-genesis which we just deleted).
    chain.chainId = chain._loadChainId();
  } else {
    // No JSONL genesis — append each entry on top of the auto-generated one.
    // Verify hashes line up.
    const tx = chain.db.prepare('BEGIN');
    const commit = chain.db.prepare('COMMIT');
    const rollback = chain.db.prepare('ROLLBACK');
    tx.run();
    try {
      for (const e of jsonlEntries) {
        const expected = entryHash(e.seq, e.prevHash, e.ts, e.payload);
        if (expected !== e.hash) {
          throw new Error(
            `migrate-v2: hash mismatch at seq ${e.seq}: expected ${expected} got ${e.hash}`
          );
        }
        chain.db
          .prepare(
            'INSERT INTO chain_entries(seq, ts, prev_hash, hash, payload) VALUES(?,?,?,?,?)'
          )
          .run(e.seq, e.ts, e.prevHash, e.hash, JSON.stringify(e.payload));
      }
      commit.run();
    } catch (e) {
      try { rollback.run(); } catch { /* ignore */ }
      chain.close();
      wipeDbArtifacts(args.db);
      process.stderr.write(`migrate-v2: ${e.message}\n`);
      process.exit(1);
    }
  }

  // Strict post-conditions.
  const v = chain.verify();
  const jsonlHead = jsonlEntries[jsonlEntries.length - 1];
  let ok = true;
  if (!v.ok) {
    process.stderr.write(`migrate-v2: post-import verify failed: ${v.reason} at seq ${v.at}\n`);
    ok = false;
  } else {
    if (v.length !== jsonlEntries.length) {
      process.stderr.write(
        `migrate-v2: length mismatch: db=${v.length} jsonl=${jsonlEntries.length}\n`
      );
      ok = false;
    }
    if (v.head !== jsonlHead.hash) {
      process.stderr.write(
        `migrate-v2: head mismatch: db=${v.head} jsonl=${jsonlHead.hash}\n`
      );
      ok = false;
    }
  }

  // Approvals.
  ensureApprovalsTable(chain);
  let approvalsImported = 0;
  try {
    const approvalRows = readApprovals(args.approvals);
    approvalsImported = importApprovals(chain, approvalRows);
  } catch (e) {
    process.stderr.write(`migrate-v2: approvals import failed: ${e.message}\n`);
    ok = false;
  }

  if (!ok) {
    chain.close();
    wipeDbArtifacts(args.db);
    process.exit(1);
  }

  process.stdout.write(
    JSON.stringify({
      migrated: true,
      entries: v.length,
      head: v.head,
      chainId: v.chainId,
      approvals: approvalsImported,
      fts: chain.fts,
    }) + '\n'
  );
  chain.close();
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`migrate-v2: unexpected: ${e.stack || e.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, parseArgs, readJsonl, readApprovals, wipeDbArtifacts };
