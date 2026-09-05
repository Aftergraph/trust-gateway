const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Z7 operator session audit trail', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-z7-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_OPERATOR_SESSION_AUDIT = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/operator-session-audit')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const osa = require('../src/gateway/operator-session-audit');
    assert.equal(osa.enabled(), true);
  });

  it('recordLogin stores event', () => {
    const osa = require('../src/gateway/operator-session-audit');
    const r = osa.recordLogin('admin', '127.0.0.1', 'test-agent', 'sess-1');
    assert.ok(r.id > 0);
    assert.equal(r.action, 'login');
  });

  it('recordLogout stores event', () => {
    const osa = require('../src/gateway/operator-session-audit');
    const r = osa.recordLogout('admin', 'sess-1');
    assert.ok(r.id > 0);
    assert.equal(r.action, 'logout');
  });

  it('getSessions returns history', () => {
    const osa = require('../src/gateway/operator-session-audit');
    const sessions = osa.getSessions('admin');
    assert.ok(sessions.length >= 2);
  });

  it('getActiveSessions excludes logged-out operators', () => {
    const osa = require('../src/gateway/operator-session-audit');
    const uniqueOp = 'test-op-' + Date.now();
    osa.recordLogin(uniqueOp, '10.0.0.1', 'agent', 'sess-unique');
    osa.recordLogout(uniqueOp, 'sess-unique');
    const active = osa.getActiveSessions();
    const found = active.filter(s => s.operator === uniqueOp);
    assert.equal(found.length, 0);
  });

  it('inert when TG_OPERATOR_SESSION_AUDIT unset', () => {
    delete process.env.TG_OPERATOR_SESSION_AUDIT;
    delete require.cache[require.resolve('../src/gateway/operator-session-audit')];
    const osa = require('../src/gateway/operator-session-audit');
    assert.equal(osa.enabled(), false);
    assert.equal(osa.recordLogin('x'), null);
    assert.equal(osa.getSessions('x'), null);
    process.env.TG_OPERATOR_SESSION_AUDIT = '1';
    delete require.cache[require.resolve('../src/gateway/operator-session-audit')];
  });
});
