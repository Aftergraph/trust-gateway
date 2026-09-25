'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');

test('STUDY-015 durable audit chain reloads exact git egress receipt after crash boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study015-tg-audit-'));
  const auditFile = path.join(root, 'audit.jsonl');

  try {
    const first = new Gateway({
      mountFiles: false,
      telemetryFile: null,
      auditFile,
      bots: {
        operator: { token: 'operator-token', role: 'operator', capabilities: ['*'] },
      },
    });
    const payload = {
      type: 'git_egress_completed',
      requestId: 'req/study015/l5',
      correlationId: 'causal/study015/live-3',
      executionContextId: 'ctx_' + '1'.repeat(32),
      actionId: 'act_' + '2'.repeat(32),
      effectId: 'effect/study015/live-3',
      repository: 'Aftergraph/runtime',
      ref: 'refs/heads/study015/l5-durable-recovery-proof-target',
      operation: 'push',
      status: 200,
    };
    const appended = first._audit(payload);
    assert.equal(appended.payload.type, 'git_egress_completed');
    assert.equal(first.chain.verify().ok, true);
    fs.closeSync(first.auditFd);
    first.auditFd = null;

    const recovered = new Gateway({
      mountFiles: false,
      telemetryFile: null,
      auditFile,
      bots: {
        operator: { token: 'operator-token', role: 'operator', capabilities: ['*'] },
      },
    });
    try {
      const verification = recovered.chain.verify();
      assert.equal(verification.ok, true);
      const matches = recovered.chain.entries.filter(
        (entry) =>
          entry.payload?.type === 'git_egress_completed' &&
          entry.payload?.actionId === payload.actionId &&
          entry.payload?.effectId === payload.effectId &&
          entry.payload?.executionContextId === payload.executionContextId,
      );
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0].payload, payload);
    } finally {
      if (recovered.auditFd !== null) fs.closeSync(recovered.auditFd);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
