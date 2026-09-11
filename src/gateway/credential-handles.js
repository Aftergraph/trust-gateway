'use strict';

const crypto = require('node:crypto');

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function normList(values, transform = (v) => v) {
  if (!Array.isArray(values) || values.length === 0) throw fail('credential_handle_invalid_scope');
  const out = [...new Set(values.map((v) => transform(String(v))).filter(Boolean))];
  if (out.length === 0) throw fail('credential_handle_invalid_scope');
  return out;
}

function hashHandle(handleId) {
  return crypto.createHash('sha256').update(String(handleId)).digest('hex');
}

function rowToPublic(row) {
  if (!row) return null;
  return {
    tenant: row.tenant,
    principalId: row.principal_id,
    missionId: row.mission_id,
    authorityRef: row.authority_ref,
    purpose: row.purpose,
    credentialClass: row.credential_class,
    allowedDestinations: JSON.parse(row.allowed_destinations_json),
    allowedMethods: JSON.parse(row.allowed_methods_json),
    allowedPathPrefixes: JSON.parse(row.allowed_path_prefixes_json),
    scopeRefs: JSON.parse(row.scope_refs_json),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

class CredentialHandleStore {
  constructor({ db, vault, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    if (!db) throw fail('credential_handle_db_required');
    if (!vault) throw fail('credential_handle_vault_required');
    this.db = db;
    this.vault = vault;
    this.now = now;
    this.randomBytes = randomBytes;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credential_handles (
        handle_hash TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        authority_ref TEXT NOT NULL,
        purpose TEXT NOT NULL,
        credential_class TEXT NOT NULL,
        allowed_destinations_json TEXT NOT NULL,
        allowed_methods_json TEXT NOT NULL,
        allowed_path_prefixes_json TEXT NOT NULL,
        scope_refs_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        revoked_reason TEXT
      )
    `);
  }

  issue(input = {}) {
    const tenant = String(input.tenant || '').trim();
    const secretKey = String(input.secretKey || '').trim();
    const principalId = String(input.principalId || '').trim();
    const missionId = String(input.missionId || '').trim();
    const authorityRef = String(input.authorityRef || '').trim();
    const purpose = String(input.purpose || '').trim();
    const credentialClass = String(input.credentialClass || '').trim();
    const issuedAt = Number(this.now());
    const expiresAt = Number(input.expiresAt);
    if (!tenant || !secretKey || !principalId || !missionId || !authorityRef || !purpose || !credentialClass) {
      throw fail('credential_handle_invalid_binding');
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw fail('credential_handle_invalid_expiry');

    // Prove the referenced secret exists at issuance without retaining plaintext.
    const secret = this.vault.getSecret(tenant, secretKey);
    if (typeof secret !== 'string') throw fail('credential_handle_secret_missing');

    const allowedDestinations = normList(input.allowedDestinations, (v) => v.trim().toLowerCase());
    const allowedMethods = normList(input.allowedMethods, (v) => v.trim().toUpperCase());
    const allowedPathPrefixes = normList(input.allowedPathPrefixes, (v) => v.trim());
    const scopeRefs = normList(input.scopeRefs, (v) => v.trim());

    const token = Buffer.from(this.randomBytes(32)).toString('base64url');
    const handleId = `ch_${token}`;
    const handleHash = hashHandle(handleId);
    this.db.prepare(`
      INSERT INTO credential_handles (
        handle_hash, tenant, secret_key, principal_id, mission_id, authority_ref,
        purpose, credential_class, allowed_destinations_json, allowed_methods_json,
        allowed_path_prefixes_json, scope_refs_json, issued_at, expires_at,
        revoked_at, revoked_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      handleHash, tenant, secretKey, principalId, missionId, authorityRef,
      purpose, credentialClass, JSON.stringify(allowedDestinations), JSON.stringify(allowedMethods),
      JSON.stringify(allowedPathPrefixes), JSON.stringify(scopeRefs), issuedAt, expiresAt,
    );

    return { handleId, ...rowToPublic(this._row(handleId)) };
  }

  _row(handleId) {
    return this.db.prepare('SELECT * FROM credential_handles WHERE handle_hash = ?').get(hashHandle(handleId));
  }

  inspect(handleId) {
    const row = this._row(handleId);
    if (!row) throw fail('credential_handle_unknown');
    return rowToPublic(row);
  }

  revoke(handleId, reason = 'revoked') {
    const row = this._row(handleId);
    if (!row) throw fail('credential_handle_unknown');
    const now = Number(this.now());
    this.db.prepare(`
      UPDATE credential_handles
      SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?)
      WHERE handle_hash = ?
    `).run(now, String(reason || 'revoked'), hashHandle(handleId));
    return this.inspect(handleId);
  }

  validate(handleId, request = {}) {
    const row = this._row(handleId);
    if (!row) throw fail('credential_handle_unknown');
    const now = Number(this.now());
    if (row.revoked_at != null) throw fail('credential_handle_revoked');
    if (now >= Number(row.expires_at)) throw fail('credential_handle_expired');
    if (String(request.principalId || '') !== row.principal_id) throw fail('credential_handle_principal_mismatch');
    if (String(request.missionId || '') !== row.mission_id) throw fail('credential_handle_mission_mismatch');
    if (String(request.authorityRef || '') !== row.authority_ref) throw fail('credential_handle_scope_mismatch');
    if (String(request.purpose || '') !== row.purpose) throw fail('credential_handle_scope_mismatch');

    const meta = rowToPublic(row);
    const destination = request.destination || {};
    const host = String(destination.host || '').toLowerCase();
    const method = String(request.http?.method || '').toUpperCase();
    const requestPath = String(request.http?.path || '');
    if (!meta.allowedDestinations.includes(host)) throw fail('credential_handle_scope_mismatch');
    if (!meta.allowedMethods.includes(method)) throw fail('credential_handle_scope_mismatch');
    if (!meta.allowedPathPrefixes.some((prefix) => requestPath.startsWith(prefix))) {
      throw fail('credential_handle_scope_mismatch');
    }
    return { ...meta, secretKey: row.secret_key };
  }

  resolveForBroker(handleId, request = {}) {
    const meta = this.validate(handleId, request);
    const secret = this.vault.getSecret(meta.tenant, meta.secretKey);
    if (typeof secret !== 'string') throw fail('credential_handle_secret_missing');
    return { ...meta, secret };
  }
}

module.exports = { CredentialHandleStore, hashHandle };
