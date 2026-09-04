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
  // WAL on DrvFs (/mnt/* under WSL) throws 'disk I/O error' when -wal/-shm sidecars
  // are stale-locked (seen after parallel shard runs). Fall back to DELETE journaling
  // rather than crashing the module import — single-writer semantics still hold.
  try {
    d.exec('PRAGMA journal_mode = WAL');
  } catch {
    d.exec('PRAGMA journal_mode = DELETE');
  }
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
  // FS-I5 — tenant-scoped secrets vault (encrypted values, see
  // secrets-vault.js). Table exists unconditionally so the schema is stable
  // whether or not TG_SECRETS_VAULT is enabled.
  d.exec(`
    CREATE TABLE IF NOT EXISTS tenant_secrets (
      tenant     TEXT NOT NULL,
      key        TEXT NOT NULL,
      value_enc  TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, key)
    );
  `);
  // FS-J1: durable conversations with message history.
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      tenant     TEXT NOT NULL,
      title      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
  `);
  return d;
}

// Single shared connection for the process (reuses data/gateway.db — the
// same file SqlChain already uses). LAZY: opening at import time made a locked/
// contended repo db crash EVERY module import (seen when parallel test runners
// hold the WAL). db opens on first use instead; resetDb() semantics unchanged.
let db = null;
let openFile = process.env.TG_DB_FILE || path.join(process.cwd(), 'data', 'gateway.db');

function _db() {
  if (!db) db = open(openFile);
  return db;
}

// Reset db connection (for tests) - replaces with fresh connection at current TG_DB_FILE
function resetDb() {
  openFile = process.env.TG_DB_FILE || path.join(process.cwd(), 'data', 'gateway.db');
  db = open(openFile);
  txDepth = 0;
}

let txDepth = 0;

/**
 * Run fn inside an IMMEDIATE transaction. Nested calls join the outer tx.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function tx(fn) {
  const db = _db();
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

module.exports = { get db() { return _db(); }, tx, json, unjson, open, resetDb };

// Auto-create audit_chain compatibility view on first require.
// Older modules reference audit_chain; sql-chain uses chain_entries.
try {
  _db().exec(`
    CREATE VIEW IF NOT EXISTS audit_chain AS
    SELECT seq, ts, prev_hash, hash, payload,
           json_extract(payload, '$.tenant') AS tenant,
           json_extract(payload, '$.type')   AS type,
           json_extract(payload, '$.data')   AS data,
           json_extract(payload, '$.bot')    AS bot
    FROM chain_entries
  `);
} catch { /* chain_entries may not exist yet; view created lazily by sql-chain init */ }
