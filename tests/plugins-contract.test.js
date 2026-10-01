'use strict';
process.env.TG_DB_FILE = require('node:path').join(
  require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')),
  'gateway.db',
);

// Plugin Contract v0.2 convergence tests.
// The canonical implementation is src/gateway/plugins.js + mounts/35-plugins.js.
// These tests deliberately assert route ownership so a second /v2/plugins
// implementation cannot silently shadow or be shadowed again.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PluginHub,
  validateManifest,
  CONTRACT_VERSION,
  PLUGIN_VIEWS,
} = require('../src/gateway/plugins');
const { loadMounts, match } = require('../src/gateway/http-mounts');

const REPO_MODULES = path.join(__dirname, '..', 'modules');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('contract v0.2: accepts and normalizes the full declarative surface', () => {
  const v = validateManifest({
    contractVersion: '0.2',
    id: 'contract-demo',
    name: 'Contract Demo',
    version: '2.0.0',
    entry: 'index.js',
    description: 'Declarative plugin.',
    capabilities: ['demo.read'],
    permissions: ['read:*', 'write:item'],
    tools: ['demo.read', 'demo.write'],
    views: ['Card', 'Table'],
    events: ['plugin.demo.changed'],
    automations: [{ id: 'sync', trigger: 'plugin.demo.changed', condition: 'ready', action: 'demo.write' }],
    sandbox: 'jailed',
    secrets: [{ name: 'API_KEY', required: true }],
    mcp: [{ name: 'demo-mcp', transport: 'stdio', command: 'node', args: ['server.js'] }],
  }, { dirName: 'contract-demo' });

  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(CONTRACT_VERSION, '0.2');
  assert.equal(v.manifest.contractVersion, '0.2');
  assert.equal(v.manifest.sandbox, 'jailed');
  assert.deepEqual(v.manifest.permissions, ['read:*', 'write:item']);
  assert.deepEqual(v.manifest.tools, ['demo.read', 'demo.write']);
  assert.deepEqual(v.manifest.views, ['Card', 'Table']);
  assert.deepEqual(v.manifest.events, ['plugin.demo.changed']);
  assert.deepEqual(v.manifest.automations, [
    { id: 'sync', trigger: 'plugin.demo.changed', condition: 'ready', action: 'demo.write' },
  ]);
});

test('contract v0.2: is a strict superset of explicit v0.1 manifests', () => {
  const v = validateManifest({
    contractVersion: '0.1',
    id: 'legacy-contract',
    name: 'Legacy Contract',
    version: '1.0.0',
    entry: 'index.js',
    permissions: ['read:*'],
    tools: ['legacy.read'],
    views: ['Card'],
    events: ['legacy.changed'],
    automations: [{ trigger: 'legacy.changed', action: 'legacy.read' }],
    sandbox: 'jailed',
  }, { dirName: 'legacy-contract' });

  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.manifest.contractVersion, '0.1');
});

test('contract v0.2: rejects unknown versions, unsafe sandbox and unknown UI primitives', () => {
  const base = {
    id: 'bad-contract',
    name: 'Bad Contract',
    version: '1.0.0',
    entry: 'index.js',
  };

  let v = validateManifest({ ...base, contractVersion: '9.9' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('contractVersion')));

  v = validateManifest({ ...base, sandbox: 'full-host' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('sandbox')));

  v = validateManifest({ ...base, views: ['Card', 'RawHTML'] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes('unknown_view:RawHTML'));

  assert.deepEqual([...PLUGIN_VIEWS], [
    'Card', 'Table', 'Form', 'Chart', 'Timeline', 'Approval', 'Progress', 'Artifact',
  ]);
});

test('contract v0.2: declarations remain declarations, not authority grants', () => {
  const v = validateManifest({
    id: 'authority-demo',
    name: 'Authority Demo',
    version: '1.0.0',
    entry: 'index.js',
    permissions: ['write:*', 'destructive:*', 'approval.decide/*'],
    tools: ['effect.delete'],
    sandbox: 'jailed',
  });

  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.manifest.permissions, ['write:*', 'destructive:*', 'approval.decide/*']);
  // Authorization is intentionally absent from validateManifest: TG/AIE
  // action-time policy remains the authority boundary.
  assert.equal(Object.hasOwn(v.manifest, 'authorized'), false);
  assert.equal(Object.hasOwn(v.manifest, 'grants'), false);
});

test('contract v0.2: canonical demo installs through PluginHub and projects declarations + seal', () => {
  const dataDir = tmpdir('plugin-contract-v02-');
  const hub = new PluginHub({ dataDir, sourceDir: REPO_MODULES });
  const installed = hub.install('demo-echo');

  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.module.contractVersion, '0.2');
  assert.equal(installed.module.sandbox, 'jailed');
  assert.deepEqual(installed.module.permissions, ['read:*']);
  assert.deepEqual(installed.module.tools, ['echo.speak']);
  assert.deepEqual(installed.module.views, ['Card']);
  assert.deepEqual(installed.module.events, ['plugin.demo-echo.spoke']);
  assert.deepEqual(installed.module.automations, []);
  assert.equal(installed.module.integrity.sealed, true);
  assert.match(installed.module.integrity.digest, /^[a-f0-9]{64}$/);
});

test('contract v0.2: /v2/plugins has exactly one object-mount owner', () => {
  const mounts = loadMounts();
  for (const method of ['GET', 'POST', 'DELETE']) {
    const pathname = method === 'DELETE' ? '/v2/plugins/demo-echo' : '/v2/plugins';
    const owners = mounts.filter((mount) => match(mount, method, pathname));
    assert.equal(
      owners.length,
      1,
      `${method} ${pathname} must have exactly one owner, got: ${owners.map((m) => m.file + ':' + m.name).join(', ')}`,
    );
    assert.equal(owners[0].file, '35-plugins.js');
    assert.equal(owners[0].name, 'v2-plugins');
  }
  assert.equal(mounts.some((mount) => mount.name === 'plugin-contract'), false);
});
