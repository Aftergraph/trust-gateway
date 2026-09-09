const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-M1 tenant lifecycle', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-m1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/kvstore')];
    delete require.cache[require.resolve('../src/gateway/tenant-lifecycle')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shouldAutoDisable returns true for already-disabled tenant', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    assert.equal(shouldAutoDisable({ id: 'a', disabled: true }, { diskPct: 50 }, Date.now()), true);
  });

  it('shouldAutoDisable returns false when below threshold', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    const now = Date.now();
    assert.equal(shouldAutoDisable({ id: 'a', disabled: false }, { diskPct: 50, lastUpdated: now }, now), false);
  });

  it('shouldAutoDisable returns true when over threshold long enough', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    const now = Date.now();
    const overSince = now - 2 * 60 * 60 * 1000; // 2h ago, > 1h default
    assert.equal(shouldAutoDisable({ id: 'a', disabled: false }, { diskPct: 98, lastUpdated: overSince }, now), true);
  });

  it('shouldAutoDisable returns false when over threshold but recent', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    const now = Date.now();
    const overSince = now - 1000; // 1s ago
    assert.equal(shouldAutoDisable({ id: 'a', disabled: false }, { diskPct: 98, lastUpdated: overSince }, now), false);
  });

  it('markAutoDisabled requires reason', () => {
    const { markAutoDisabled } = require('../src/gateway/tenant-lifecycle');
    const r = markAutoDisabled('acme', '', 'op1');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing_reason');
  });

  it('cleanupOrphanedTenants returns empty on fresh DB', () => {
    const { cleanupOrphanedTenants } = require('../src/gateway/tenant-lifecycle');
    const r = cleanupOrphanedTenants();
    assert.deepEqual(r, []);
  });
});

describe('TEN tenant lifecycle admission (tenant-lifecycle/0.1)', () => {
  const HEX32 = '0123456789abcdef0123456789abcdef';
  function tenRecord(overrides = {}) {
    return {
      schema: 'tenant-lifecycle/0.1',
      lifecycle_id: `lif_${HEX32}`,
      tenant_id: `ten_${HEX32}`,
      state: 'active',
      previous_state: null,
      required_owners: ['owner-a', 'owner-b'],
      owner_acknowledgements: [],
      attempted_action: { kind: 'none', at: '2026-09-09T00:00:00Z' },
      recorded_at: '2026-09-09T00:00:00Z',
      ...overrides,
    };
  }
  const decide = (rec) => require('../src/gateway/tenant-lifecycle').decideTenantAction(rec);
  const transition = (rec, to) => require('../src/gateway/tenant-lifecycle').canTransitionTenant(rec, to);

  it('TEN-001: ACTIVE with recorded acknowledgements admits grant', () => {
    const r = decide(tenRecord({
      state: 'active',
      owner_acknowledgements: [{ owner: 'owner-a', ack: 'retention' }],
      attempted_action: { kind: 'grant', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, true);
  });

  it('TEN-001: ACTIVE admits grant even with no acks (acks gate only terminal completion)', () => {
    const r = decide(tenRecord({
      state: 'active',
      attempted_action: { kind: 'grant', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, true);
  });

  it('TEN-002: DELETING denies new grants', () => {
    const r = decide(tenRecord({
      state: 'deleting', previous_state: 'active',
      attempted_action: { kind: 'grant', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-002: DELETING denies ingestion', () => {
    const r = decide(tenRecord({
      state: 'deleting', previous_state: 'active',
      attempted_action: { kind: 'ingestion', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-002: DELETING denies execution', () => {
    const r = decide(tenRecord({
      state: 'deleting', previous_state: 'active',
      attempted_action: { kind: 'execution', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-003: complete_deletion without all owner acks is rejected', () => {
    const r = decide(tenRecord({
      state: 'deleting', previous_state: 'active',
      owner_acknowledgements: [{ owner: 'owner-a', ack: 'deletion' }],
      attempted_action: { kind: 'complete_deletion', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-003: complete_deletion admitted only with every required owner deletion ack', () => {
    const r = decide(tenRecord({
      state: 'deleting', previous_state: 'active',
      owner_acknowledgements: [
        { owner: 'owner-a', ack: 'deletion' },
        { owner: 'owner-b', ack: 'deletion' },
      ],
      attempted_action: { kind: 'complete_deletion', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, true);
  });

  it('TEN-003: retention ack does not satisfy deletion completion', () => {
    const r = decide(tenRecord({
      state: 'deleting', previous_state: 'active',
      owner_acknowledgements: [
        { owner: 'owner-a', ack: 'deletion' },
        { owner: 'owner-b', ack: 'retention' },
      ],
      attempted_action: { kind: 'complete_deletion', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-003: duplicate ack from one owner does not cover another owner', () => {
    const r = decide(tenRecord({
      state: 'deleting', previous_state: 'active',
      owner_acknowledgements: [
        { owner: 'owner-a', ack: 'deletion' },
        { owner: 'owner-a', ack: 'deletion' },
      ],
      attempted_action: { kind: 'complete_deletion', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-003: complete_deletion outside DELETING is denied even with full acks', () => {
    const r = decide(tenRecord({
      state: 'active',
      owner_acknowledgements: [
        { owner: 'owner-a', ack: 'deletion' },
        { owner: 'owner-b', ack: 'deletion' },
      ],
      attempted_action: { kind: 'complete_deletion', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-004: SUSPENDED denies execution', () => {
    const r = decide(tenRecord({
      state: 'suspended', previous_state: 'active',
      attempted_action: { kind: 'execution', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-004: SUSPENDED still admits grants (only execution is gated)', () => {
    const r = decide(tenRecord({
      state: 'suspended', previous_state: 'active',
      attempted_action: { kind: 'grant', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, true);
  });

  it('TEN-005: EXPORTING denies ingestion', () => {
    const r = decide(tenRecord({
      state: 'exporting', previous_state: 'active',
      attempted_action: { kind: 'ingestion', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('TEN-005: EXPORTING still admits execution (only ingestion is gated)', () => {
    const r = decide(tenRecord({
      state: 'exporting', previous_state: 'active',
      attempted_action: { kind: 'execution', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, true);
  });

  it('TEN-005: complete_export admitted only with every required owner export ack', () => {
    const denied = decide(tenRecord({
      state: 'exporting', previous_state: 'active',
      owner_acknowledgements: [{ owner: 'owner-a', ack: 'export' }],
      attempted_action: { kind: 'complete_export', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(denied.admitted, false);
    const admitted = decide(tenRecord({
      state: 'exporting', previous_state: 'active',
      owner_acknowledgements: [
        { owner: 'owner-a', ack: 'export' },
        { owner: 'owner-b', ack: 'export' },
      ],
      attempted_action: { kind: 'complete_export', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(admitted.admitted, true);
  });

  it('DELETED denies all new actions', () => {
    const r = decide(tenRecord({
      state: 'deleted', previous_state: 'deleting',
      attempted_action: { kind: 'grant', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('unknown state denies (fail-closed)', () => {
    const r = decide(tenRecord({
      state: 'archived',
      attempted_action: { kind: 'grant', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('unknown action kind denies (fail-closed)', () => {
    const r = decide(tenRecord({
      state: 'active',
      attempted_action: { kind: 'launch', at: '2026-09-09T00:00:00Z' },
    }));
    assert.equal(r.admitted, false);
  });

  it('DELETING→ACTIVE transition is rejected (no state-transition bypass)', () => {
    const r = transition(tenRecord({
      state: 'deleting', previous_state: 'active',
      owner_acknowledgements: [
        { owner: 'owner-a', ack: 'deletion' },
        { owner: 'owner-b', ack: 'deletion' },
      ],
    }), 'active');
    assert.equal(r.allowed, false);
  });

  it('DELETING→DELETED requires all owner acks', () => {
    const denied = transition(tenRecord({
      state: 'deleting', previous_state: 'active',
      owner_acknowledgements: [{ owner: 'owner-a', ack: 'deletion' }],
    }), 'deleted');
    assert.equal(denied.allowed, false);
    const allowed = transition(tenRecord({
      state: 'deleting', previous_state: 'active',
      owner_acknowledgements: [
        { owner: 'owner-a', ack: 'deletion' },
        { owner: 'owner-b', ack: 'deletion' },
      ],
    }), 'deleted');
    assert.equal(allowed.allowed, true);
  });

  it('DELETED is terminal: no outbound transitions', () => {
    const r = transition(tenRecord({ state: 'deleted', previous_state: 'deleting' }), 'active');
    assert.equal(r.allowed, false);
  });
});

describe('TEN schema discriminator (tenant-lifecycle/0.1)', () => {
  const HEX32 = '0123456789abcdef0123456789abcdef';
  function tenRecord(overrides = {}) {
    return {
      schema: 'tenant-lifecycle/0.1',
      lifecycle_id: `lif_${HEX32}`,
      tenant_id: `ten_${HEX32}`,
      state: 'active',
      previous_state: null,
      required_owners: ['owner-a', 'owner-b'],
      owner_acknowledgements: [],
      attempted_action: { kind: 'grant', at: '2026-09-09T00:00:00Z' },
      recorded_at: '2026-09-09T00:00:00Z',
      ...overrides,
    };
  }
  const decide = (rec) => require('../src/gateway/tenant-lifecycle').decideTenantAction(rec);
  const transition = (rec, to) => require('../src/gateway/tenant-lifecycle').canTransitionTenant(rec, to);

  it('incompatible schema version is denied even for active/grant', () => {
    const r = decide(tenRecord({ schema: 'tenant-lifecycle/9.0' }));
    assert.equal(r.admitted, false);
  });

  it('missing schema is denied even for active/grant', () => {
    const rec = tenRecord();
    delete rec.schema;
    const r = decide(rec);
    assert.equal(r.admitted, false);
  });

  it('malformed acknowledgements are denied even for active/grant', () => {
    const r = decide(tenRecord({
      owner_acknowledgements: [{ owner: 'owner-a' }],
    }));
    assert.equal(r.admitted, false);
  });

  it('missing required_owners is denied even for active/grant', () => {
    const rec = tenRecord();
    delete rec.required_owners;
    const r = decide(rec);
    assert.equal(r.admitted, false);
  });

  it('valid 0.1 record is still admitted', () => {
    const r = decide(tenRecord());
    assert.equal(r.admitted, true);
  });

  it('transition with incompatible schema is denied', () => {
    const r = transition(tenRecord({ schema: 'tenant-lifecycle/9.0' }), 'suspended');
    assert.equal(r.allowed, false);
  });

  it('transition with missing schema is denied', () => {
    const rec = tenRecord();
    delete rec.schema;
    const r = transition(rec, 'suspended');
    assert.equal(r.allowed, false);
  });

  it('transition with valid 0.1 record is still allowed', () => {
    const r = transition(tenRecord(), 'suspended');
    assert.equal(r.allowed, true);
  });

  it('records missing audit identity fields are denied, not admitted', () => {
    for (const field of ['lifecycle_id', 'tenant_id', 'recorded_at']) {
      const rec = tenRecord();
      delete rec[field];
      const d = decide(rec);
      assert.equal(d.admitted, false, `missing ${field} must deny`);
      assert.match(d.reason, /schema/);
      const t = transition(rec, 'suspended');
      assert.equal(t.allowed, false, `missing ${field} must block transition`);
    }
    const noActionAt = tenRecord({ attempted_action: { kind: 'grant' } });
    assert.equal(decide(noActionAt).admitted, false);
    const badPrev = tenRecord({ previous_state: 'not-a-state' });
    assert.equal(decide(badPrev).admitted, false);
    assert.equal(transition(badPrev, 'suspended').allowed, false);
  });
});
