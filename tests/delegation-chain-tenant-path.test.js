'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TenantStore } = require('../src/gateway/tenants');
const { scopeDir, delegationChainFile } = require('../src/gateway/tenant-scope');
const { Gateway } = require('../src/gateway/server');
const { getChain } = require('../src/gateway/mounts/27-delegation-chain');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chain-tenant-'));
  const tenantStore = new TenantStore({ dataDir: path.join(root, 'data') });
  tenantStore.ensureMain();
  tenantStore.create({ name: 'tenant-a' });
  tenantStore.create({ name: 'tenant-b' });
  return { root, tenantStore };
}

test('tenant graph paths derive inside the existing tenant-scope root', () => {
  const { root, tenantStore } = setup();
  const a = scopeDir(tenantStore, null, 'tenant-a', 'memory');
  const b = scopeDir(tenantStore, null, 'tenant-b', 'memory');
  assert.equal(a, path.join(root, 'data', 'tenants', 'tenant-a', 'memory'));
  assert.equal(b, path.join(root, 'data', 'tenants', 'tenant-b', 'memory'));
  assert.notEqual(a, b);
});

test('only valid tenant ids can produce durable graph paths', () => {
  const { tenantStore } = setup();
  assert.throws(() => scopeDir(tenantStore, null, '../escape', 'memory'), /fail closed/);
  assert.throws(() => scopeDir(tenantStore, null, 'a/b', 'memory'), /fail closed/);
  assert.throws(() => scopeDir(tenantStore, null, 'TENANT-A', 'memory'), /fail closed/);
});

test('gateway derives a durable graph path from tenant id', () => {
  const { root } = setup();
  process.env.TG_DATA_DIR = path.join(root, 'data');
  const gateway = new Gateway({ mountFiles: false, delegationChainTenantId: 'tenant-a' });
  try {
    getChain(gateway).record(null, 'derived-root', { kind: 'goal', from: 'tenant-a' }, 'room-a');
    assert.equal(fs.existsSync(path.join(root, 'data', 'tenants', 'tenant-a', 'memory', 'delegation-chain.json')), true);
  } finally {
    gateway.server?.close();
  }
});

test('gateway durable graph files remain isolated by tenant path', () => {
  const { tenantStore } = setup();
  const fileA = delegationChainFile(tenantStore, null, 'tenant-a');
  const fileB = delegationChainFile(tenantStore, null, 'tenant-b');
  const gwA = new Gateway({ mountFiles: false, delegationChainFile: fileA });
  const gwB = new Gateway({ mountFiles: false, delegationChainFile: fileB });
  try {
    getChain(gwA).record(null, 'a-root', { kind: 'goal', from: 'tenant-a' }, 'room-a');
    assert.ok(getChain(gwA).chain('a-root'));
    assert.equal(getChain(gwB).chain('a-root'), null);
    assert.equal(fs.existsSync(fileA), true);
    assert.equal(fs.existsSync(fileB), false);
  } finally {
    gwA.server?.close();
    gwB.server?.close();
  }
});
