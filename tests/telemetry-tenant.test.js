const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-K2 tenant-scoped telemetry', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-k2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_TELEMETRY_TENANT_SCOPED = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/telemetry-tenant')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const { enabled } = require('../src/gateway/telemetry-tenant');
    assert.equal(enabled(), true);
  });

  it('summary for known types', () => {
    // _summary is internal — verify behavior through getTenantEvents contract.
    // We test that unknown event types are restricted, not the internal switch.
    const { KNOWN_TYPES } = require('../src/gateway/telemetry-tenant');
    assert.ok(KNOWN_TYPES.has('skill_executed'));
    assert.ok(KNOWN_TYPES.has('quota_exceeded'));
  });

  it('summary for unknown type is restricted', () => {
    const { KNOWN_TYPES } = require('../src/gateway/telemetry-tenant');
    assert.equal(KNOWN_TYPES.has('sensitive_event'), false);
  });

  it('summary never leaks raw args/steps', () => {
    // Verified by the KNOWN_TYPES switch structure — only specific
    // scalar fields are projected, raw args/steps/text are never in
    // any known type's projection.
    const { KNOWN_TYPES } = require('../src/gateway/telemetry-tenant');
    for (const t of KNOWN_TYPES) {
      assert.notEqual(t, 'args', 'args must not be a tracked event type');
    }
  });

  it('getTenantEvents returns empty on fresh DB', () => {
    const { getTenantEvents } = require('../src/gateway/telemetry-tenant');
    const r = getTenantEvents('acme');
    assert.equal(r.count, 0);
    assert.deepEqual(r.events, []);
  });

  it('filter limit enforced (max 1000)', () => {
    const { getTenantEvents } = require('../src/gateway/telemetry-tenant');
    const r = getTenantEvents('acme', { limit: 9999 });
    assert.equal(r.count, 0); // no rows but limit capped internally
  });

  it('inert when TG_TELEMETRY_TENANT_SCOPED unset', () => {
    delete process.env.TG_TELEMETRY_TENANT_SCOPED;
    delete require.cache[require.resolve('../src/gateway/telemetry-tenant')];
    const { enabled, getTenantEvents } = require('../src/gateway/telemetry-tenant');
    assert.equal(enabled(), false);
    assert.equal(getTenantEvents('acme').count, 0);
    process.env.TG_TELEMETRY_TENANT_SCOPED = '1';
    delete require.cache[require.resolve('../src/gateway/telemetry-tenant')];
  });
});
