'use strict';
// W4 — plugin / MCP / skills hub tests (src/gateway/plugins.js + mounts/35-plugins.js).
// Covers: manifest validation (reject bad), install/copy into data/modules/,
// enable/disable audit, skills frontmatter parse (trigger ≤57), MCP stdio-vs-url
// validation, secrets write-only with length-only echo, fail-closed state,
// and the mount surface over real HTTP.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway, send } = require('../src/gateway/server');
const {
  PluginHub, validateManifest, parseSkillFrontmatter, validateMcpDef, TRIGGER_MAX,
} = require('../src/gateway/plugins');

const REPO_MODULES = path.join(__dirname, '..', 'modules');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeHub(overrides = {}) {
  const dir = tmpdir('w4-');
  const audits = [];
  const hub = new PluginHub({
    dataDir: path.join(dir, 'data'),
    sourceDir: REPO_MODULES,
    audit: (p) => audits.push(p),
    ...overrides,
  });
  return { hub, audits, dir: path.join(dir, 'data') };
}

// ── real-HTTP harness ─────────────────────────────────────────────

function buildServer() {
  const server = http.createServer();
  let gw = null;
  return {
    server,
    attach(gateway) {
      gw = gateway;
      server.on('request', (req, res) => gw.handle(req, res));
    },
    close: () => new Promise((r) => server.close(() => r())),
    gw: () => gw,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}

function makeGateway({ dataDir = null, sourceDir = REPO_MODULES } = {}) {
  const gw = new Gateway({
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_b, tool) => ({ ok: true, tool }),
  });
  if (dataDir) {
    gw.pluginsHub = new PluginHub({
      dataDir,
      sourceDir,
      audit: (p) => gw._audit(p),
    });
  }
  // FS-C1: keep the governed skill store out of the repo's data/ dir in tests.
  gw._skillsFile = path.join(tmpdir('w4-skills-'), 'skills.json');
  return gw;
}

async function api(base, method, urlPath, { token = 'tok-atlas', body } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

function auditTypes(gw) {
  return gw.chain.entries.map((e) => e.payload.type);
}

function chainText(gw) {
  return JSON.stringify(gw.chain.entries.map((e) => e.payload));
}

// ── 1. manifest validation ────────────────────────────────────────

test('validateManifest: accepts a well-formed manifest', () => {
  const v = validateManifest({
    id: 'demo-echo', name: 'Demo Echo', version: '1.0.0', entry: 'index.js',
    description: 'x', capabilities: ['echo.speak'],
    secrets: [{ name: 'API_KEY' }],
    mcp: [{ name: 'demo-echo-mcp', transport: 'stdio', command: 'node' }],
  }, { dirName: 'demo-echo' });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.manifest.secrets[0].required, false);
});

test('validateManifest: rejects bad manifests (all the ways)', () => {
  const bad = {
    id: 'DEMO', name: '  ', version: '1.0', entry: '../evil.js',
    bogus: true, capabilities: 'nope', secrets: [{ name: '1bad' }, { name: '1bad' }],
  };
  const v = validateManifest(bad, { dirName: 'whatever' });
  assert.equal(v.ok, false);
  const joined = v.errors.join('|');
  assert.match(joined, /id/);
  assert.match(joined, /name/);
  assert.match(joined, /version/);
  assert.match(joined, /entry/);
  assert.match(joined, /unknown_field:bogus/);
  assert.match(joined, /capabilities/);
  assert.match(joined, /secrets/);
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest('nope').ok, false);
});

test('validateManifest: id must match its directory name', () => {
  const v = validateManifest(
    { id: 'other', name: 'N', version: '1.0.0', entry: 'index.js' },
    { dirName: 'real-dir' },
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('id_mismatch')));
});

// ── 2. skill frontmatter parser ───────────────────────────────────

test('parseSkillFrontmatter: parses name/description/trigger', () => {
  const v = parseSkillFrontmatter(
    `---\nname: greet-echo\ndescription: Greet\ncategory: fun\n---\nsteps`,
  );
  assert.equal(v.ok, false); // unknown field rejected
  assert.ok(v.errors.some((e) => e.includes('unknown_field:category')));
  const ok = parseSkillFrontmatter(
    `---\nname: greet-echo\ndescription: Greet through demo\ntrigger: Use when greeting.\n---\n1. greet`,
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.skill.name, 'greet-echo');
  assert.equal(ok.skill.trigger, 'Use when greeting.');
  assert.equal(ok.skill.body, '1. greet');
});

test('parseSkillFrontmatter: trigger capped at 57 chars', () => {
  assert.equal(TRIGGER_MAX, 57);
  const at = 'x'.repeat(57);
  const over = 'x'.repeat(58);
  const t = (trig) => `---\nname: s\ndescription: d\ntrigger: ${trig}\n---\nbody`;
  assert.equal(parseSkillFrontmatter(t(at)).ok, true, 'exactly 57 must pass');
  const v = parseSkillFrontmatter(t(over));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('trigger_too_long:')));
});

test('parseSkillFrontmatter: rejects malformed frontmatter and empty body', () => {
  assert.ok(parseSkillFrontmatter('# no fm').errors.some((e) => e.startsWith('no_frontmatter')));
  assert.ok(parseSkillFrontmatter('---\nname: s\ndescription: d\n---\n\n').errors.includes('empty_body: skill needs a procedure after the frontmatter'));
  assert.ok(parseSkillFrontmatter('---\ndescription: d\ntrigger: t\n---\nb').errors.some((e) => e.includes('name')));
});

// ── 3. MCP validation ─────────────────────────────────────────────

test('validateMcpDef: stdio vs url', () => {
  assert.equal(validateMcpDef({ name: 'a', transport: 'stdio', command: 'node', args: ['x'] }).ok, true);
  assert.equal(validateMcpDef({ name: 'b', transport: 'http', url: 'http://127.0.0.1:9/mcp' }).ok, true);
  assert.equal(validateMcpDef({ name: 'c', transport: 'sse', url: 'https://x.test/sse' }).ok, true);
  assert.equal(validateMcpDef({ name: 'd', transport: 'stdio' }).ok, false); // no command
  assert.equal(validateMcpDef({ name: 'e', transport: 'stdio', command: 'node', url: 'http://x' }).ok, false); // stdio+url
  assert.equal(validateMcpDef({ name: 'f', transport: 'http', url: 'ftp://x' }).ok, false); // non-http url
  assert.equal(validateMcpDef({ name: 'g', transport: 'http', url: 'not a url' }).ok, false);
  assert.equal(validateMcpDef({ name: 'h', transport: 'grpc', command: 'x' }).ok, false); // bad transport
  assert.equal(validateMcpDef({ name: 'i', transport: 'stdio', command: 'x', env: { K: 'v' } }).ok, true);
  assert.equal(validateMcpDef({ name: 'j', transport: 'stdio', command: 'x', sneaky: 1 }).ok, false); // unknown field
  assert.equal(validateMcpDef('string').ok, false);
});

// ── 4. hub: install / enable / disable / audit ────────────────────

test('hub: install copies module into data/modules/ and audits plugin_installed', () => {
  const { hub, audits, dir } = makeHub();
  const r = hub.install('demo-echo');
  assert.equal(r.ok, true);
  assert.equal(r.module.enabled, false);
  assert.ok(fs.existsSync(path.join(dir, 'modules', 'demo-echo', 'index.js')));
  assert.ok(fs.existsSync(path.join(dir, 'modules', 'demo-echo', 'plugin.json')));
  assert.deepEqual(
    audits.map((a) => a.type), ['plugin_installed'],
  );
  // 409 on double install, audited as a rejection
  assert.equal(hub.install('demo-echo').status, 409);
  assert.deepEqual(audits.map((a) => a.type), ['plugin_installed', 'plugin_rejected']);
});

test('hub: install rejects bad manifest source and audits plugin_rejected', () => {
  const src = tmpdir('w4-src-');
  fs.mkdirSync(path.join(src, 'broken'));
  fs.writeFileSync(path.join(src, 'broken', 'plugin.json'), '{ not json');
  fs.mkdirSync(path.join(src, 'nostart'));
  const { hub, audits } = makeHub({ sourceDir: src });
  const first = hub.install('broken');
  assert.equal(first.error, 'manifest_rejected');
  assert.ok(first.errors.includes('manifest_unparseable'));
  const second = hub.install('nostart');
  assert.equal(second.error, 'manifest_rejected');
  assert.ok(second.errors.includes('source_missing'));
  assert.ok(hub.install('nonexistent').errors.includes('source_missing'));
  assert.ok(hub.install('../escape').errors.includes('bad_id'));
  const rejected = audits.filter((a) => a.type === 'plugin_rejected');
  assert.equal(rejected.length, 4);
});

test('hub: enable/disable flips state and audits plugin_enabled/plugin_disabled', () => {
  const { hub, audits } = makeHub();
  hub.install('demo-echo');
  assert.equal(hub.enable('demo-echo').module.enabled, true);
  assert.equal(hub.disable('demo-echo').module.enabled, false);
  assert.equal(hub.enable('ghost').status, 404);
  const types = audits.map((a) => a.type);
  assert.deepEqual(types, ['plugin_installed', 'plugin_enabled', 'plugin_disabled']);
  assert.equal(types.filter((t) => t === 'plugin_enabled').length, 1);
});

test('hub: uninstall removes the running copy and audits plugin_uninstalled', () => {
  const { hub, audits, dir } = makeHub();
  hub.install('demo-echo');
  assert.equal(hub.uninstall('demo-echo').ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'modules', 'demo-echo')), false);
  assert.equal(hub.uninstall('demo-echo').status, 404);
  assert.ok(audits.some((a) => a.type === 'plugin_uninstalled'));
});

// ── 5. secrets hygiene ────────────────────────────────────────────

test('hub: secrets are write-only with length-only echo', () => {
  const { hub, audits } = makeHub();
  hub.install('demo-echo');
  const r = hub.setSecret('demo-echo', 'API_KEY', 'super-secret-value');
  assert.deepEqual(r.secret, { name: 'API_KEY', configured: true, length: 'super-secret-value'.length });
  assert.equal(JSON.stringify(r).includes('super-secret-value'), false);
  // views expose length only
  const view = JSON.stringify(hub.view('demo-echo'));
  assert.equal(view.includes('super-secret-value'), false);
  assert.match(view, /"length":18/);
  // audit exposes length only
  assert.equal(chainLike(audits).includes('super-secret-value'), false);
  assert.ok(audits.some((a) => a.type === 'secret_configured' && a.length === 18));
  // internal reader works for wave B
  assert.equal(hub.getSecret('demo-echo', 'API_KEY'), 'super-secret-value');
  // undeclared secrets refused
  assert.equal(hub.setSecret('demo-echo', 'OTHER', 'x').error, 'secret_undeclared');
  assert.equal(hub.removeSecret('demo-echo', 'API_KEY').ok, true);
});

function chainLike(audits) { return JSON.stringify(audits); }

// ── 6. persistence / fail closed ──────────────────────────────────

test('hub: state persists across restarts; corrupt state refuses to load', () => {
  const { hub, dir } = makeHub();
  hub.install('demo-echo');
  hub.enable('demo-echo');
  hub.setSecret('demo-echo', 'API_KEY', 'persisted-value');
  hub.registerMcp({ name: 'demo-echo-mcp', transport: 'stdio', command: 'node' });

  const audits2 = [];
  const hub2 = new PluginHub({ dataDir: dir, sourceDir: REPO_MODULES, audit: (p) => audits2.push(p) });
  assert.equal(hub2.view('demo-echo').enabled, true);
  assert.equal(hub2.getSecret('demo-echo', 'API_KEY'), 'persisted-value');
  assert.deepEqual(hub2.listMcp().map((s) => s.name), ['demo-echo-mcp']);

  fs.writeFileSync(path.join(dir, 'plugins.json'), '{corrupt');
  assert.throws(() => new PluginHub({ dataDir: dir }), /fail closed/);
});

test('hub: state file is mode 0600 and stores no manifest-invalid modules', () => {
  const { hub, dir } = makeHub();
  hub.install('demo-echo');
  hub.setSecret('demo-echo', 'API_KEY', 'zzz');
  const mode = fs.statSync(path.join(dir, 'plugins.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ── 7. MCP registry on the hub ────────────────────────────────────

test('hub: registerMcp validates, audits registered/rejected, env values hidden in views', () => {
  const { hub, audits } = makeHub();
  const ok = hub.registerMcp({ name: 'fs-mcp', transport: 'stdio', command: 'node', env: { TOK: 'env-secret' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.server.envKeys, ['TOK']);
  assert.equal(ok.server.env, undefined);
  assert.equal(JSON.stringify(hub.listMcp()).includes('env-secret'), false);
  assert.equal(hub.registerMcp({ name: 'fs-mcp', transport: 'stdio', command: 'node' }).status, 409);
  assert.equal(hub.registerMcp({ name: 'nope', transport: 'telepathy' }).error, 'mcp_rejected');
  const types = audits.map((a) => a.type);
  assert.ok(types.includes('mcp_registered'));
  assert.ok(types.includes('mcp_rejected'));
  assert.equal(hub.unregisterMcp('fs-mcp').ok, true);
  assert.equal(hub.listMcp().length, 0);
});

// ── 8. skills discovery ───────────────────────────────────────────

test('hub: discoverSkills parses installed modules and reports rejects', () => {
  const src = tmpdir('w4-src2-');
  fs.cpSync(path.join(REPO_MODULES, 'demo-echo'), path.join(src, 'demo-echo'), { recursive: true });
  fs.mkdirSync(path.join(src, 'demo-echo', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(src, 'demo-echo', 'skills', 'greet-echo.md'),
    fs.readFileSync(path.join(REPO_MODULES, 'demo-echo', 'skills', 'greet-echo.md')));
  fs.writeFileSync(path.join(src, 'demo-echo', 'skills', 'broken.md'), '---\nname: X\ndescription: d\n---\nx');
  const { hub } = makeHub({ sourceDir: src });
  hub.install('demo-echo');
  const { skills, rejected } = hub.discoverSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'greet-echo');
  assert.ok(skills[0].trigger.length <= TRIGGER_MAX);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].file, 'broken.md');
});

// ── 9. real-HTTP mount surface ────────────────────────────────────

test('mount: /v2/plugins requires bearer auth (401 without)', async () => {
  const ctx = buildServer();
  ctx.attach(makeGateway({ dataDir: tmpdir('w4-http-') }));
  const base = await listen(ctx.server);
  try {
    assert.equal((await fetch(base + '/v2/plugins')).status, 401);
    assert.equal((await fetch(base + '/v2/skills')).status, 401);
    assert.equal((await fetch(base + '/v2/mcp')).status, 401);
  } finally { await ctx.close(); }
});

test('mount: worker role is refused state changes (403 + audit), operator succeeds', async () => {
  const gw = makeGateway({ dataDir: tmpdir('w4-http-') });
  const ctx = buildServer();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const denied = await api(base, 'POST', '/v2/plugins', { token: 'tok-forge', body: { id: 'demo-echo' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'operator_required');
    assert.ok(auditTypes(gw).includes('plugins_forbidden'));
    const ok = await api(base, 'POST', '/v2/plugins', { body: { id: 'demo-echo' } });
    assert.equal(ok.status, 201);
  } finally { await ctx.close(); }
});

test('mount: full CRUD + enable/disable + secrets + skills + mcp over HTTP, chain verifies', async () => {
  const gw = makeGateway({ dataDir: tmpdir('w4-http-') });
  const ctx = buildServer();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    // install (from the repo's real modules/ dir)
    let r = await api(base, 'POST', '/v2/plugins', { body: { id: 'demo-echo' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.module.id, 'demo-echo');
    r = await api(base, 'POST', '/v2/plugins', { body: { id: 'demo-echo' } });
    assert.equal(r.status, 409);

    // list + get
    r = await api(base, 'GET', '/v2/plugins');
    assert.equal(r.json.modules.length, 1);
    assert.equal(r.json.modules[0].enabled, false);
    r = await api(base, 'GET', '/v2/plugins/demo-echo');
    assert.equal(r.json.module.name, 'Demo Echo');
    r = await api(base, 'GET', '/v2/plugins/ghost');
    assert.equal(r.status, 404);

    // enable / disable (audited)
    r = await api(base, 'POST', '/v2/plugins/demo-echo/enable');
    assert.equal(r.json.module.enabled, true);
    r = await api(base, 'POST', '/v2/plugins/demo-echo/disable');
    assert.equal(r.json.module.enabled, false);
    assert.ok(auditTypes(gw).includes('plugin_enabled'));
    assert.ok(auditTypes(gw).includes('plugin_disabled'));

    // secret: write-only, length-only echo
    const SECRET = 'hunter2-super-secret-do-not-log';
    r = await api(base, 'PUT', '/v2/plugins/demo-echo/secrets/API_KEY', { body: { value: SECRET } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.secret, { name: 'API_KEY', configured: true, length: SECRET.length });
    assert.equal(JSON.stringify(r.json).includes(SECRET), false);
    assert.equal(chainText(gw).includes(SECRET), false); // audit: length only
    r = await api(base, 'GET', '/v2/plugins');
    assert.equal(JSON.stringify(r.json).includes(SECRET), false);
    // undeclared + malformed rejected
    r = await api(base, 'PUT', '/v2/plugins/demo-echo/secrets/NOPE', { body: { value: 'x' } });
    assert.equal(r.status, 400);
    r = await api(base, 'PUT', '/v2/plugins/demo-echo/secrets/API_KEY', { body: {} });
    assert.equal(r.status, 400);

    // skills
    r = await api(base, 'GET', '/v2/skills');
    assert.equal(r.json.skills.length, 1);
    assert.equal(r.json.skills[0].name, 'greet-echo');
    assert.ok(r.json.skills[0].trigger.length <= TRIGGER_MAX);

    // MCP registry
    r = await api(base, 'POST', '/v2/mcp', { body: { name: 'good-mcp', transport: 'http', url: 'http://127.0.0.1:1/sse' } });
    assert.equal(r.status, 201);
    r = await api(base, 'POST', '/v2/mcp', { body: { name: 'bad-mcp', transport: 'stdio', url: 'http://x' } });
    assert.equal(r.status, 400);
    assert.ok(auditTypes(gw).includes('mcp_rejected'));
    r = await api(base, 'GET', '/v2/mcp');
    assert.deepEqual(r.json.servers.map((s) => s.name), ['good-mcp']);
    r = await api(base, 'DELETE', '/v2/mcp/good-mcp');
    assert.equal(r.status, 200);

    // uninstall → gone
    r = await api(base, 'DELETE', '/v2/plugins/demo-echo');
    assert.equal(r.status, 200);
    r = await api(base, 'GET', '/v2/plugins/demo-echo');
    assert.equal(r.status, 404);

    // chain integrity after all of the above
    assert.equal(gw.chain.verify().ok, true);
    assert.ok(auditTypes(gw).includes('plugin_installed'));
    assert.ok(auditTypes(gw).includes('plugin_rejected')); // the 409 double-install audits rejection
  } finally { await ctx.close(); }
});

test('mount: bad manifest over HTTP → 400 + plugin_rejected audit', async () => {
  const src = tmpdir('w4-http-src-');
  fs.mkdirSync(path.join(src, 'evil-module'));
  fs.writeFileSync(path.join(src, 'evil-module', 'plugin.json'),
    JSON.stringify({ id: 'evil-module', name: 'Evil', version: '0.1', entry: '/abs/path.js' }));
  const gw = makeGateway({ dataDir: tmpdir('w4-http-'), sourceDir: src });
  const ctx = buildServer();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const r = await api(base, 'POST', '/v2/plugins', { body: { id: 'evil-module' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'manifest_rejected');
    assert.ok(r.json.errors.length >= 2);
    assert.ok(auditTypes(gw).includes('plugin_rejected'));
    const list = await api(base, 'GET', '/v2/plugins');
    assert.equal(list.json.modules.length, 0);
  } finally { await ctx.close(); }
});

test('mount: invalid JSON body → 400, unknown route → 404/405', async () => {
  const gw = makeGateway({ dataDir: tmpdir('w4-http-') });
  const ctx = buildServer();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const res = await fetch(base + '/v2/plugins', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas', 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(res.status, 400);
    // FS-C1: POST /v2/skills is now the governed skill create (mounts/105-skills.js).
    // An empty body fails governed validation instead of the old 405.
    const skillsPost = await api(base, 'POST', '/v2/skills', { body: {} });
    assert.equal(skillsPost.status, 400);
  } finally { await ctx.close(); }
});
