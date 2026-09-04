'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('NeedsYouStore', () => {
  let store;
  let now = 0;

  beforeEach(() => {
    now = 1000000;
    store = require('../src/gateway/needsyou').NeedsYouStore;
  });

  test('create items with valid types', () => {
    const s = new store({ now: () => now });
    const item = s.create({
      tenantId: 't1',
      type: 'clarification',
      subject: 'Need clarification',
    });
    assert(item.id.startsWith('nys_'));
    assert.strictEqual(item.tenantId, 't1');
    assert.strictEqual(item.type, 'clarification');
    assert.strictEqual(item.status, 'open');
    assert.strictEqual(item.createdAt, now);
  });

  test('resolve an item', () => {
    const s = new store({ now: () => now });
    const item = s.create({
      tenantId: 't1',
      type: 'budget',
      subject: 'Need budget',
    });
    const result = s.resolve(item.id, 'operator1');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.item.status, 'resolved');
    assert.strictEqual(result.item.resolvedAt, now);
    assert.strictEqual(result.item.resolvedBy, 'operator1');
  });

  test('listByTenant returns tenant-specific items', () => {
    const s = new store({ now: () => now });
    s.create({ tenantId: 't1', type: 'budget', subject: 'Budget for t1' });
    s.create({ tenantId: 't2', type: 'budget', subject: 'Budget for t2' });
    s.create({ tenantId: 't1', type: 'approval', subject: 'Approval for t1' });

    const t1Items = s.listByTenant('t1');
    assert.strictEqual(t1Items.length, 2);
    const t2Items = s.listByTenant('t2');
    assert.strictEqual(t2Items.length, 1);
  });

  test('listOpen sorts by urgency', () => {
    now = 1000;
    const s = new store({ now: () => now });
    now += 100;
    s.create({ tenantId: 't1', type: 'clarification', subject: 'Clarification' });
    now += 100;
    s.create({ tenantId: 't1', type: 'budget', subject: 'Budget' });
    now += 100;
    s.create({ tenantId: 't1', type: 'approval', subject: 'Approval' });
    now += 100;
    s.create({ tenantId: 't1', type: 'credential', subject: 'Credential' });

    const items = s.listOpen();
    assert.strictEqual(items.length, 4);
    assert.strictEqual(items[0].type, 'approval');
    assert.strictEqual(items[1].type, 'budget');
    assert.strictEqual(items[2].type, 'credential');
    assert.strictEqual(items[3].type, 'clarification');
  });

  test('get returns null for non-existent', () => {
    const s = new store({ now: () => now });
    const item = s.get('nys_000000');
    assert.strictEqual(item, null);
  });

  test('resolve on non-existent returns not_found', () => {
    const s = new store({ now: () => now });
    const result = s.resolve('nys_000000', 'op1');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'not_found');
  });

  test('resolve on already resolved returns error', () => {
    const s = new store({ now: () => now });
    const item = s.create({
      tenantId: 't1',
      type: 'approval',
      subject: 'Test',
    });
    s.resolve(item.id, 'op1');
    const result = s.resolve(item.id, 'op2');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'already_resolved');
  });
});

describe('urgencyScore', () => {
  const { urgencyScore } = require('../src/gateway/needsyou');

  test('approval has highest priority (0)', () => {
    assert.strictEqual(urgencyScore('approval'), 0);
  });

  test('budget has second priority (1)', () => {
    assert.strictEqual(urgencyScore('budget'), 1);
  });

  test('credential has third priority (2)', () => {
    assert.strictEqual(urgencyScore('credential'), 2);
  });

  test('clarification has lowest priority (3)', () => {
    assert.strictEqual(urgencyScore('clarification'), 3);
  });

  test('unknown type returns 99', () => {
    assert.strictEqual(urgencyScore('unknown'), 99);
  });
});
