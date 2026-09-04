'use strict';
// FS-Z4 — backup encryption at rest.
// Encrypts backup archives with AES-256-GCM using a key derived from
// TG_BACKUP_ENCRYPTION_KEY env var. Inert when unset (backups remain plaintext).
// Key derivation: scrypt(key, salt='tg-backup-v1', N=16384, r=8, p=1, dkLen=32).

const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const SALT = 'tg-backup-v1';
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const DK_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function enabled() {
  return !!process.env.TG_BACKUP_ENCRYPTION_KEY;
}

function _deriveKey() {
  const raw = process.env.TG_BACKUP_ENCRYPTION_KEY;
  if (!raw) throw new Error('TG_BACKUP_ENCRYPTION_KEY not set');
  return crypto.scryptSync(raw, SALT, DK_LEN, SCRYPT_OPTS);
}

function encrypt(plaintext) {
  if (!enabled()) return null;
  const key = _deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, enc]);
}

function decrypt(ciphertext) {
  if (!enabled()) return null;
  if (!ciphertext || ciphertext.length < IV_LEN + TAG_LEN + 1) {
    throw Object.assign(new Error('invalid_ciphertext'), { code: 'invalid_ciphertext' });
  }
  const key = _deriveKey();
  const iv = ciphertext.subarray(0, IV_LEN);
  const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = ciphertext.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (err) {
    throw Object.assign(new Error('decryption_failed'), { code: 'decryption_failed', cause: err });
  }
}

module.exports = { enabled, encrypt, decrypt, ALGO, IV_LEN, TAG_LEN };
