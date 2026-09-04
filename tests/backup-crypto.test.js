const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('FS-Z4 backup encryption at rest', () => {
  let origEnv;

  before(() => {
    origEnv = { ...process.env };
    process.env.TG_BACKUP_ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
    delete require.cache[require.resolve('../src/gateway/backup-crypto')];
  });

  after(() => {
    process.env = origEnv;
  });

  it('enabled respects env', () => {
    const bc = require('../src/gateway/backup-crypto');
    assert.equal(bc.enabled(), true);
  });

  it('encrypt returns buffer', () => {
    const bc = require('../src/gateway/backup-crypto');
    const enc = bc.encrypt(Buffer.from('hello world'));
    assert.ok(Buffer.isBuffer(enc));
    assert.ok(enc.length > 12 + 16); // iv + tag + ciphertext
  });

  it('decrypt recovers plaintext', () => {
    const bc = require('../src/gateway/backup-crypto');
    const plain = Buffer.from('secret backup data');
    const enc = bc.encrypt(plain);
    const dec = bc.decrypt(enc);
    assert.deepEqual(dec, plain);
  });

  it('decrypt rejects tampered ciphertext', () => {
    const bc = require('../src/gateway/backup-crypto');
    const enc = bc.encrypt(Buffer.from('data'));
    enc[enc.length - 1] ^= 0xff; // flip last byte
    assert.throws(() => bc.decrypt(enc), /decryption_failed/);
  });

  it('decrypt rejects too-short input', () => {
    const bc = require('../src/gateway/backup-crypto');
    assert.throws(() => bc.decrypt(Buffer.alloc(10)), /invalid_ciphertext/);
  });

  it('inert when TG_BACKUP_ENCRYPTION_KEY unset', () => {
    delete process.env.TG_BACKUP_ENCRYPTION_KEY;
    delete require.cache[require.resolve('../src/gateway/backup-crypto')];
    const bc = require('../src/gateway/backup-crypto');
    assert.equal(bc.enabled(), false);
    assert.equal(bc.encrypt(Buffer.from('x')), null);
    assert.equal(bc.decrypt(Buffer.alloc(50)), null);
    process.env.TG_BACKUP_ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
    delete require.cache[require.resolve('../src/gateway/backup-crypto')];
  });
});
