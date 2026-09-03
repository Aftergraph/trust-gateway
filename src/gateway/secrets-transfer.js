'use strict';
// FS-L1 — tenant-to-tenant secret transfer (operator-mediated, atomic).
//
// transferSecret({fromTenant, toTenant, key, reason, by}) reads the plaintext
// value from the SOURCE tenant's vault, writes it to the DEST tenant's vault
// (re-encrypted with the dest tenant's per-tenant key), then deletes the
// source row — all in a SINGLE transaction (atomic: never a copy without
// a source delete, never a delete without a successful dest write).
//
// Inert when TG_SECRETS_VAULT unset — transferSecret() throws 'transfer_disabled'.
//
// Refuses:
//   fromTenant === toTenant                 → 400 same_tenant
//   source row missing                      → 404 source_missing
//   dest row already exists                 → 409 dest_conflict
//   key not a valid slug                    → 400 invalid_key
//   reason missing or >200 chars            → 400 missing_reason | reason_too_long
//
// Plaintext is NEVER logged, audited, or returned to the API caller — only
// tenant ids, key name, reason, and the by operator name hit the chain.

const { tx } = require('./db');
const { isValidTenantId } = require('./tenants');
const { SecretsVault } = require('./secrets-vault');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_REASON = 200;

function enabled() {
  if (process.env.TG_SECRETS_VAULT !== '1') return false;
  if (!process.env.TG_SECRETS_MASTER_KEY) return false;
  if (process.env.TG_SECRETS_MASTER_KEY.length < 16) return false;
  return true;
}

let _vaultSingleton = null;
function _vault() {
  if (!_vaultSingleton) _vaultSingleton = new SecretsVault();
  return _vaultSingleton;
}

/**
 * Transfer a secret from one tenant to another.
 * @param {object} args
 * @param {string} args.fromTenant
 * @param {string} args.toTenant
 * @param {string} args.key
 * @param {string} args.reason
 * @param {string} args.by
 * @returns {object} {transferredAt, key, fromTenant, toTenant}
 */
function transferSecret({ fromTenant, toTenant, key, reason, by } = {}) {
  if (!enabled()) {
    const err = new Error('transfer_disabled');
    err.code = 'transfer_disabled';
    throw err;
  }
  if (!fromTenant || !toTenant || !key) {
    const err = new Error('missing_fields');
    err.code = 'missing_fields';
    throw err;
  }
  if (!isValidTenantId(fromTenant) || !isValidTenantId(toTenant)) {
    const err = new Error('invalid_tenant');
    err.code = 'invalid_tenant';
    throw err;
  }
  if (!SLUG_RE.test(key)) {
    const err = new Error('invalid_key');
    err.code = 'invalid_key';
    throw err;
  }
  if (fromTenant === toTenant) {
    const err = new Error('same_tenant');
    err.code = 'same_tenant';
    throw err;
  }
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    const err = new Error('missing_reason');
    err.code = 'missing_reason';
    throw err;
  }
  if (reason.length > MAX_REASON) {
    const err = new Error('reason_too_long');
    err.code = 'reason_too_long';
    throw err;
  }

  const transferredAt = Date.now();

  // Atomic: read source, write dest, delete source — all in one tx.
  return tx(() => {
    const plaintext = _vault().getSecret(fromTenant, key);
    if (plaintext === null) {
      const err = new Error('source_missing');
      err.code = 'source_missing';
      throw err;
    }
    const existing = _vault().getSecret(toTenant, key);
    if (existing !== null) {
      const err = new Error('dest_conflict');
      err.code = 'dest_conflict';
      throw err;
    }
    const wrote = _vault().setSecret(toTenant, key, plaintext);
    if (!wrote) {
      const err = new Error('dest_write_failed');
      err.code = 'dest_write_failed';
      throw err;
    }
    const removed = _vault().deleteSecret(fromTenant, key);
    if (!removed) {
      // Should not happen (we just read it), but fail closed
      const err = new Error('source_delete_failed');
      err.code = 'source_delete_failed';
      throw err;
    }
    return { transferredAt, key, fromTenant, toTenant, by };
  });
}

module.exports = {
  enabled,
  transferSecret,
  SLUG_RE,
  MAX_REASON,
};
