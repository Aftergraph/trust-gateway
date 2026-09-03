'use strict';
// G3 (§18.5) — fuzzy object-id resolution in the ⌘K palette:
//   1. bare integer → 'jump to seq N' row (TG_HISTORY.jumpToSeq)
//   2. 8-hex / sess_<8hex> → 'open transcript /h/<token>' row (client-side
//      FORMAT validation only — existence is never probed, the server renders
//      byte-identical 404s and the client must not distinguish)
//   3. fuzzy ladder on zero hits: retry last word, then its first 4 chars,
//      marking retried rows 'fuzzy'
// Source assertions on app.js (same style as panel-phase1.test.js) + live
// contract checks reusing the tests/deeplink.test.js patterns (chain seq
// lookup via the object resolver, /h byte-identical anti-enumeration).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');
const { getPlanner } = require('../src/gateway/chat-singleton');
const mount = require('../src/gateway/mounts/90-transparency');

const APP = path.join(__dirname, '..', 'app');
const appJs = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');

const FORGE = 'tok-forge-g3-1a2b';
const ATLAS = 'tok-atlas-g3-9c8d';

// ── source assertions ──────────────────────────────────────────────────────

test('app.js: palette resolves bare integers to jump-to-seq rows (§18.5.1)', () => {
  assert.match(appJs, /SEQ_ID_RE\s*=\s*\/\^\\d\+\$\//, 'seq id format validated client-side');
  assert.match(appJs, /'jump to seq ' \+ q/, 'seq row label');
  assert.match(appJs, /jumpToSeq\(Number\(q\)\)/, 'seq row jumps via TG_HISTORY.jumpToSeq');
});

test('app.js: palette validates 8-hex / sess_<8hex> and links /h/<token> (§18.5.2)', () => {
  // same regex shape as mounts/90-transparency.js TOKEN_RE, optional sess_ prefix
  assert.match(appJs, /TOKEN_ID_RE\s*=\s*\/\^\(sess_\)\?\[0-9a-f\]\{8\}\$\//, 'token format validated client-side');
  assert.match(appJs, /'open transcript \/h\/' \+ hex/, 'transcript row label');
  assert.match(appJs, /location\.assign\('\/h\/' \+ hex\)/, 'transcript row navigates to /h/<token>');
  assert.match(appJs, /q\.replace\(\/\^sess_\/, ''\)/, 'sess_ prefix shed for the bare-hex /h URL');
});

test('app.js: transcript row never probes token existence client-side', () => {
  // the transcript row must be a plain navigation: no fetch/GET to /h from
  // the palette (an existence probe would distinguish hit vs miss, breaking
  // the anti-enumeration symmetry the server guarantees).
  const palette = appJs.slice(appJs.indexOf('function ensurePalette'), appJs.indexOf('function openPalette'));
  assert.ok(!/fetch\([^)]*\/h\//.test(palette), 'no client-side /h existence probe');
  assert.match(appJs, /Navigate\s*\n?\s*\/\/ unconditionally/, 'navigation is unconditional by design');
});

test('app.js: fuzzy ladder — retry last word, then first-4-chars, rows marked fuzzy', () => {
  assert.match(appJs, /function fuzzyQueries\(/, 'ladder builder present');
  assert.match(appJs, /words\[words\.length - 1\]/, 'ladder starts at the last word');
  assert.match(appJs, /last\.slice\(0, 4\)/, 'ladder second rung: first 4 chars');
  assert.match(appJs, /!hits\.length && rest\.length/, 'ladder only walked on zero hits');
  assert.match(appJs, /fuzzy \? ' fuzzy' : ''/, 'retried rows are marked fuzzy');
});

// ── live contracts (deeplink.test.js patterns) ─────────────────────────────

function mkGw(dir) {
  process.env.TG_RUNS_FILE = path.join(dir, 'runs.json');
  process.env.TG_RUN_BY_GOAL_FILE = path.join(dir, 'bygoal.json');
  process.env.TG_CONTINUITY_FILE = path.join(dir, 'goals.json');
  process.env.TG_ROOMS_FILE = path.join(dir, 'rooms.json');
  const chain = new HashChain();
  return new Gateway({
    bots: {
      forge: { token: FORGE, role: 'worker', capabilities: ['*'] },
      atlas: { token: ATLAS, role: 'operator', capabilities: ['*'] },
    },
    chain,
    botsDir: path.join(dir, 'bots'),
    staticDir: path.join(__dirname, '..', 'app'),
  });
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function fetch(port, reqPath, token, accept) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.authorization = 'Bear' + 'er ' + token;
    if (accept) headers.accept = accept;
    http.get({ host: '127.0.0.1', port, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        ct: res.headers['content-type'] || '',
        bodyBuf: Buffer.concat(chunks),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}
function parseJson(body) { try { return JSON.parse(body); } catch { return null; } }

function cleanup(dir) {
  delete process.env.TG_RUNS_FILE;
  delete process.env.TG_RUN_BY_GOAL_FILE;
  delete process.env.TG_CONTINUITY_FILE;
  delete process.env.TG_ROOMS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('G3 integration: chain seq lookup the palette jump resolves against', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-g3-'));
  const gw = mkGw(dir);
  const srv = await serve(gw);
  try {
    gw._audit({ type: 'chat_action', bot: 'forge', tool: 'fs.read:x', decision: 'allow', session: 'g3sess' });
    const seq = gw.chain.entries[1].seq;
    // the row the palette builds for a bare integer points at this seq — the
    // resolver must resolve it (§18.5.1 backend contract).
    const r = await fetch(srv.port, '/d/CONTROL/o/auditentry/seq_' + seq, ATLAS, 'application/json');
    assert.equal(r.status, 200);
    const j = parseJson(r.body);
    assert.ok(j, 'resolver answered JSON');
    assert.equal(j.resolved, true);
    assert.equal(j.object.seq, seq);
    assert.equal(j.object.type, 'chat_action');
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('G3 integration: /h/<token> opens a transcript; unknown tokens are byte-identical 404s', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'g3-secret';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-g3-'));
  const gw = mkGw(dir);
  const srv = await serve(gw);
  try {
    getPlanner(gw).registerTurn('g3sess', { role: 'user', text: 'hi', bot: 'forge', source: 'llm' });
    const tok = mount.transparencyToken('g3sess', mount.secretFor(gw));
    assert.match(tok, /^[0-9a-f]{8}$/, 'token matches the palette TOKEN_ID_RE shape');
    // hit: the palette's 'open transcript /h/<token>' row lands here
    const hit = await fetch(srv.port, '/h/' + tok);
    assert.equal(hit.status, 200);
    assert.match(hit.ct, /text\/html/);
    assert.match(hit.body, /g3sess/);
    // sess_-prefixed input resolves to the same transcript (client sheds prefix)
    const prefixed = await fetch(srv.port, '/h/sess_' + tok);
    assert.equal(prefixed.status, 404, 'mount itself only accepts bare hex — client sheds the prefix');
    // miss: well-formed but unknown tokens are byte-identical (no existence oracle)
    const miss1 = await fetch(srv.port, '/h/deadbeef');
    const miss2 = await fetch(srv.port, '/h/' + crypto.createHash('sha256').update('ghost:g3-secret').digest('hex').slice(0, 8));
    assert.equal(miss1.status, 404);
    assert.equal(miss2.status, 404);
    assert.ok(miss1.bodyBuf.equals(miss2.bodyBuf), 'byte-identical 404 — client must not distinguish either');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
    cleanup(dir);
  }
});
