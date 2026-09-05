'use strict';
// WI boundary admission mount — fail-closed tests.
// work-intelligence-boundary/1.0: WI may only propose; admission never executes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mount = require('../src/gateway/mounts/125-work-intelligence-admission');

function makeReq(body) {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: payload };
        },
      };
    },
  };
}

function makeRes() {
  let captured = null;
  return {
    _captured: () => captured,
    writeHead: (code, headers) => { captured = { code, headers }; },
    end: (text) => { captured.body = text; },
  };
}

describe('WI→TG admission boundary (work-intelligence-boundary/1.0)', () => {
  const gw = { chain: { verify: () => [] } };
  const ctx = {};

  it('accepts a valid detection proposal → admitted-for-observation', async () => {
    const res = makeRes();
    await mount.handle(gw, makeReq({
      proposal_version: '1.0',
      kind: 'detection-proposal',
      source: 'conversation-adapter',
      observed_at: '2026-09-05T10:00:00Z',
      tenant_id: 't-1',
      body: { summary: 'spike', observations: [{ id: 'o1', text: 'x', detected_at: '2026-09-05T10:00:00Z' }] },
      authority_declaration: { execution_authority: 'none', promotion_required: true, human_review_required: true },
    }), res, ctx);
    assert.equal(res._captured().code, 201);
    const record = JSON.parse(res._captured().body);
    assert.equal(record.decision, 'admitted-for-observation');
    assert.equal(record.admission_version, '1.0');
  });

  it('rejects when authority_declaration claims execution authority (fail-closed)', async () => {
    const res = makeRes();
    await mount.handle(gw, makeReq({
      proposal_version: '1.0',
      kind: 'detection-proposal',
      source: 'conversation-adapter',
      tenant_id: 't-1',
      body: { summary: 'spike', observations: [{ id: 'o1', text: 'x', detected_at: '2026-09-05T10:00:00Z' }] },
      authority_declaration: { execution_authority: 'yes', promotion_required: false, human_review_required: false },
    }), res, ctx);
    assert.equal(res._captured().code, 422);
    assert.equal(JSON.parse(res._captured().body).decision, 'rejected');
    assert.equal(JSON.parse(res._captured().body).reason, 'authority_declaration_violation');
  });

  it('rejects proposals carrying execution fields (command/promote)', async () => {
    const res = makeRes();
    await mount.handle(gw, makeReq({
      proposal_version: '1.0',
      kind: 'detection-proposal',
      source: 'conversation-adapter',
      tenant_id: 't-1',
      body: { summary: 'spike', observations: [{ id: 'o1', text: 'x', detected_at: '2026-09-05T10:00:00Z' }] },
      authority_declaration: { execution_authority: 'none', promotion_required: true, human_review_required: true },
      command: 'rm -rf /',
    }), res, ctx);
    assert.equal(res._captured().code, 422);
    assert.equal(JSON.parse(res._captured().body).reason, 'execution_field_present');
  });

  it('rejects non-detection kind and missing source', async () => {
    const res1 = makeRes();
    await mount.handle(gw, makeReq({ proposal_version: '1.0', kind: 'command' }), res1, ctx);
    assert.equal(res1._captured().code, 422);
    assert.equal(JSON.parse(res1._captured().body).reason, 'unsupported_kind');

    const res2 = makeRes();
    await mount.handle(gw, makeReq({
      proposal_version: '1.0', kind: 'detection-proposal', source: '', tenant_id: 't-1',
      body: { summary: 's', observations: [] },
      authority_declaration: { execution_authority: 'none', promotion_required: true, human_review_required: true },
    }), res2, ctx);
    assert.equal(res2._captured().code, 422);
    assert.equal(JSON.parse(res2._captured().body).reason, 'missing_source');
  });
});