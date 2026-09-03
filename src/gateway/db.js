'use strict';
// FS-A4 — shared SQLite plumbing for the Trust Gateway (phase 1 of the
// SQLite unification). SqlChain already owns the chain tables in
// data/gateway.db; this module opens THE SAME file and hands every other
// store (kv_store today, more later) a single shared connection.
//
//   - db      : the one DatabaseSync connection (module singleton).
//   - tx(fn)  : BEGIN IMMEDIATE / COMMIT, ROLLBACK on throw. Nested tx()
//               calls join the outer transaction (depth counter), so
//               store methods can compose inside a caller's transaction.
//   - json(v) : JSON-serialize a value for a TEXT column (undefined → null).
//   - unjson(s): inverse with a null fallback for corrupt/legacy cells.
//
// PRAGMAs mirror sql-chain.js: WAL, synchronous NORMAL, foreign keys ON.
// File resolution: TG_DB_FILE env override (tests), else <cwd>/data/gateway.db.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function resolveDbFile() {
  return (
    process.env.TG_DB_FILE ||
    path.join(process.cwd(), 'data', 'gateway.db')
  );
}

function open(file = resolveDbFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA synchronous = NORMAL');
  d.exec('PRAGMA foreign_keys = ON');
  // Shared schema: generic key/value store (JSON-serialized values).
  d.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  // FS-I3: per-tenant quota caps (NULL column → env-configurable default).
  d.exec(`
    CREATE TABLE IF NOT EXISTS tenant_quotas (
      tenant           TEXT PRIMARY KEY,
      max_disk_mb      INTEGER,
      max_api_per_hour INTEGER,
      updated_at       INTEGER NOT NULL
    );
  `);
  return d;
}

// Single shared connection for the process (reuses data/gateway.db — the
// same file SqlChain already uses; WAL allows both connections to coexist).
const db = open();

let txDepth = 0;

/**
 * Run fn inside an IMMEDIATE transaction. Nested calls join the outer tx.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function tx(fn) {
  if (txDepth > 0) return fn(); // join the outer transaction
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    txDepth--;
  }
}

/** Serialize a value for a TEXT column. undefined → null. */
function json(v) {
  return v === undefined ? null : JSON.stringify(v ?? null);
}

/** Inverse of json(): parse a stored cell, null fallback on missing/corrupt. */
function unjson(s) {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = { db, tx, json, unjson, open };
