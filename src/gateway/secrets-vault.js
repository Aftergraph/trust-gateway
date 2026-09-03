'use strict';
// FS-I5 — tenant-scoped secrets vault. Per-tenant encrypted at rest: values
// are AES-256-GCM ciphertexts keyed by a per-tenant key derived from
// TG_SECRETS_MASTER_KEY via scrypt (salt = the tenant id — attacker-visible
// but NOT secret, so deriving on it is honest: the MASTER key is the secret,
// per-tenant keys are for domain separation so one tenant's ciphertexts are
// useless on another tenant's rows even under the same master).
//
// Table tenant_secrets(tenant TEXT, key TEXT, value_enc TEXT,
//                      updated_at INTEGER, PRIMARY KEY(tenant,key)) — created
// in db.js open() next to kv_store, so every store shares the one connection.
//
//   setSecret(tenant, key, plaintext) → bool      upsert; returns success
//   getSecret(tenant, key)            → string|null
//   listKeys(tenant)                  → [key]     keys only, never values
//   deleteSecret(tenant, key)         → bool      true when a row was removed
//   rotateMasterKey(newMasterKey)     → {ok, rotatedCount, failedKeys}
//                                     FS-J2: re-encrypts EVERY row under the
//                                     new master in ONE tx — any row that
//                                     fails to decrypt aborts the whole
//                                     rotation (rollback, zero writes), so
//                                     rotation is never partial. On success
//                                     this.master AND process.env
//                                     .TG_SECRETS_MASTER_KEY move to the new
//                                     key so subsequent ops use it.
//
// ENV GATE: everything is inert unless TG_SECRETS_VAULT=1 AND a
// TG_SECRETS_MASTER_KEY is configured. Unset → setSecret throws
// 'vault_disabled', getSecret returns null, listKeys returns [],
// deleteSecret returns false — byte-identical legacy behavior for every
// pre-FS-I5 caller. A set-but-missing master key fails CLOSED (throw on
// set, null/[]/false on reads) rather than silently storing plaintext.
//
// Keys are plaintext column values (they are identifiers, not secrets);
// tenants are validated with the same strict-slug discipline as tenants.js —
// the crypto scopes by tenant id, so a key stored under 'main' must never
// read back under 'main-2' or any other id.

const crypto = require('node:crypto');
const { db, tx } = require('./db');
const { isValidTenantId } = require('./tenants');

const TABLE = 'tenant_secrets';
const ALGO = 'aes-256-gcm';

// Key-derivation tuning: scrypt defaults (N=16384, r=8, p=1, keyLen=32) are
// a deliberate cost floor — deriving per (master, tenant) pair at most once
// per process via a bounded cache.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

function vaultEnabled() {
  return process.env.TG_SECRETS_VAULT === '1';
}

function masterKey() {
  return process.env.TG_SECRETS_MASTER_KEY || null;
}

// (masterKey, tenant) → derived key Buffer, cached per process. Master-key
// change is picked up by the cache key, so old rows fail to decrypt honestly.
const derivedKeys = new Map();
function tenantKey(master, tenant) {
  const ck = master + '\u0000' + tenant;
  let k = derivedKeys.get(ck);
  if (!k) {
    k = crypto.scryptSync(master, tenant, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    derivedKeys.set(ck, k);
  }
  return k;
}

function encrypt(master, tenant, plaintext) {
  const key = tenantKey(master, tenant);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(master, tenant, stored) {
  const parts = String(stored).split('.');
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, encB64] = parts;
  try {
    const key = tenantKey(master, tenant);
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(encB64, 'base64')),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } catch {
    return null; // wrong master key / tampered row / foreign tenant row → honest null
  }
}

class SecretsVault {
  /**
   * @param {object} [opts]
   * @param {import('node:sqlite').DatabaseSync} [opts.db] Override connection (tests).
   * @param {boolean} [opts.enabled] Force-enable beyond the env gate (tests).
   * @param {string}  [opts.master]  Force master key beyond the env (tests).
   * @param {Function} [opts.now]     clock override (tests) → epoch ms.
   */
  constructor({ db: dbh = db, enabled, master, now } = {}) {
    this.db = dbh;
    this.enabled = enabled !== undefined ? !!enabled : vaultEnabled();
    this.master = master !== undefined ? master : masterKey();
    this.now = now ?? (() => Date.now());
    if (this.enabled) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          tenant     TEXT NOT NULL,
          key        TEXT NOT NULL,
          value_enc  TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant, key)
        );
      `);
    }
  }

  /** Env-gated + master-keyed: any write attempt without both throws. */
  _writeGuard() {
    if (!this.enabled) {
      throw new Error('vault_disabled (set TG_SECRETS_VAULT=1 to enable)');
    }
    if (!this.master) {
      throw new Error('vault_master_key_missing (set TG_SECRETS_MASTER_KEY)');
    }
  }

  setSecret(tenant, key, plaintext) {
    this._writeGuard();
    if (!isValidTenantId(tenant)) {
      throw new Error('vault: invalid tenant id (fail closed)');
    }
    if (typeof key !== 'string' || !key) {
      throw new Error('vault: secret key required');
    }
    if (typeof plaintext !== 'string') {
      throw new Error('vault: secret value must be a string');
    }
    const enc = encrypt(this.master, tenant, plaintext);
    return tx(() => {
      this.db
        .prepare(
          `INSERT INTO ${TABLE}(tenant, key, value_enc, updated_at) VALUES(?, ?, ?, ?)
           ON CONFLICT(tenant, key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`
        )
        .run(tenant, key, enc, this.now());
      return true;
    });
  }

  /** Plaintext or null (absent, vault off, or undecryptable — never throws). */
  getSecret(tenant, key) {
    if (!this.enabled || !this.master) return null;
    if (!isValidTenantId(tenant) || typeof key !== 'string' || !key) return null;
    const row = this.db
      .prepare(`SELECT value_enc FROM ${TABLE} WHERE tenant = ? AND key = ?`)
      .get(tenant, key);
    if (!row) return null;
    return decrypt(this.master, tenant, row.value_enc);
  }

  /** Secret KEYS only, ordered — never values (list route emits exactly this). */
  listKeys(tenant) {
    if (!this.enabled || !isValidTenantId(tenant)) return [];
    return this.db
      .prepare(`SELECT key FROM ${TABLE} WHERE tenant = ? ORDER BY key`)
      .all(tenant)
      .map((r) => r.key);
  }

  /** Remove one secret; true when a row was deleted. Inert (false) when off. */
  deleteSecret(tenant, key) {
    if (!this.enabled || !isValidTenantId(tenant) || typeof key !== 'string') return false;
    return tx(() => {
      const r = this.db
        .prepare(`DELETE FROM ${TABLE} WHERE tenant = ? AND key = ?`)
        .run(tenant, key);
      return r.changes > 0;
    });
  }

  /**
   * FS-J2 — master-key rotation: re-encrypt EVERY row under newMasterKey in a
   * single transaction. ALL-OR-NOTHING: if any row fails to decrypt under the
   * current master (corrupt row / stale master / foreign writer), the tx
   * rolls back — zero rows written — and the failure list is returned so the
   * operator can heal the row(s) and retry. Never partial: a vault that
   * rotated half-way is strictly worse than one that did not rotate at all
   * (the old master would silently stop working for half the rows).
   *
   * On success this.master and process.env.TG_SECRETS_MASTER_KEY are moved to
   * newMasterKey so every subsequent op (and the derived-key cache, keyed by
   * master) uses the new key.
   *
   * @param {string} newMasterKey
   * @returns {{ok: boolean, rotatedCount: number,
   *            failedKeys?: {tenant: string, key: string, error: string}[]}}
   */
  rotateMasterKey(newMasterKey) {
    this._writeGuard(); // vault_disabled / vault_master_key_missing
    if (typeof newMasterKey !== 'string' || newMasterKey.length < 16) {
      throw new Error('vault: new master key too short (min 16 chars)');
    }
    if (newMasterKey === this.master) {
      throw new Error('vault: new master key equals current master key');
    }

    // Snapshot + decrypt OUTSIDE the tx first: a failed decrypt must abort
    // BEFORE we open the write window, and tx() must stay short. Encryption
    // of the snapshots is pure — same inputs give the same ciphertext shape —
    // so doing it inside the tx is only the INSERTs, not the scrypt work.
    const rows = this.db.prepare(`SELECT tenant, key, value_enc FROM ${TABLE}`).all();
    const failedKeys = [];
    const reEncrypted = [];
    for (const row of rows) {
      const plain = decrypt(this.master, row.tenant, row.value_enc);
      if (plain === null) {
        failedKeys.push({ tenant: row.tenant, key: row.key, error: 'decrypt_failed_under_current_master' });
        continue;
      }
      reEncrypted.push({ tenant: row.tenant, key: row.key, enc: encrypt(newMasterKey, row.tenant, plain) });
    }
    if (failedKeys.length > 0) {
      return { ok: false, rotatedCount: 0, failedKeys };
    }

    tx(() => {
      const upd = this.db.prepare(
        `UPDATE ${TABLE} SET value_enc = ?, updated_at = ? WHERE tenant = ? AND key = ?`
      );
      for (const r of reEncrypted) upd.run(r.enc, this.now(), r.tenant, r.key);
      return true;
    });

    // Commit succeeded → adopt the new master for every subsequent op.
    this.master = newMasterKey;
    process.env.TG_SECRETS_MASTER_KEY = newMasterKey;
    return { ok: true, rotatedCount: reEncrypted.length };
  }
}

// One vault per gateway instance (WeakMap singleton, same pattern as tenants).
const vaults = new WeakMap();

/** WeakMap-cached SecretsVault; reads env gate lazily on first call. */
function getSecretsVault(gw, opts = {}) {
  let v = vaults.get(gw);
  if (!v) {
    v = new SecretsVault(opts);
    vaults.set(gw, v);
  }
  return v;
}

// Test-only cache reset (master-key rotation scenarios). Not used in prod paths.
function _resetVaultCache() {
  derivedKeys.clear();
}

module.exports = {
  SecretsVault,
  getSecretsVault,
  _resetVaultCache,
  TABLE,
  ALGO,
};
