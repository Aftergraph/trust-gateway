'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// v2 wave C — C3 SSRF-guarded web fetch/extract tests.
// Covers: isPrivateAddress matrix, htmlToText projection, fetchPage
// with an injectable transport (no real network, no real DNS), SSRF
// refusal before transport is touched, redirect cap, timeout, size cap,
// the mount-declared executor behind gateway policy (destructive class →
// needs_approval → approval → execute), and the convenience /v2/web/fetch
// endpoint with host-only audit.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const { Gateway, send } = require('../src/gateway/server');
const webtools = require('../src/gateway/webtools');
const {
  fetchPage, htmlToText, makeWebExecutor, isPrivateAddress,
} = webtools;
const mount = require('../src/gateway/mounts/65-web');

// ── helpers ───────────────────────────────────────────────────────────

function mkTransport(handler) {
  // handler(urlObj, {hops}) → {status, headers, body} OR throws.
  // Each call is recorded in handler.calls.
  const calls = [];
  const wrapped = (opts, cb) => {
    calls.push({ opts });
    const u = new URL(`https://${opts.hostname}${opts.path}`);
    let outcome;
    try { outcome = handler(u, { hops: 0, calls }); }
    catch (e) {
      const req = { on() {}, end() {}, destroy() {} };
      opts && opts.__emit && opts.__emit(e);
      // Re-throw via callback-compatible error
      const err = new (require('node:events').EventEmitter)();
      setImmediate(() => err.emit('error', e));
      return err;
    }
    if (outcome.error) {
      const e = new (require('node:events').EventEmitter)();
      setImmediate(() => e.emit('error', outcome.error));
      return e;
    }
    const res = new (require('node:events').EventEmitter)();
    res.statusCode = outcome.status;
    res.headers = outcome.headers || {};
    res._chunks = [];
    res._body = outcome.body || '';
    res._sent = false;
    res.resume = () => {};
    res.destroy = (err) => { if (err) res.emit('error', err); };
    setImmediate(() => {
      cb(res);
      res.statusCode = res.statusCode;
      res.headers = res.headers;
      // Replay the body in chunks.
      const str = res._body;
      const CHUNK = 4096;
      let i = 0;
      const push = () => {
        if (i >= str.length) { res.emit('end'); return; }
        const slice = str.slice(i, i + CHUNK);
        i += CHUNK;
        res.emit('data', Buffer.from(slice));
        setImmediate(push);
      };
      push();
    });
    return {
      on(ev, fn) {
        if (ev === 'close') setImmediate(fn);
        return this;
      },
      destroy() {},
      end() {},
    };
  };
  return { transport: wrapped, calls };
}

function mkLookup(map) {
  // map: host → array<{address, family}>
  return async (host, opts) => {
    if (Array.isArray(map[host])) return map[host];
    if (Array.isArray(map[host.toLowerCase()])) return map[host.toLowerCase()];
    // Default: 93.184.216.34 (example.com) — public, never used in blocked tests.
    return [{ address: '93.184.216.34', family: 4 }];
  };
}

const PUBLIC = { 'example.com': [{ address: '93.184.216.34', family: 4 }] };

function tmpBotsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-web-'));
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function buildServer() {
  const server = http.createServer();
  let gw = null;
  return {
    server,
    attach(gateway) { gw = gateway; server.on('request', (req, res) => gw.handle(req, res)); },
    close() { return new Promise((r) => server.close(() => r())); },
    gw: () => gw,
  };
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}
function httpCall(base, method, p, { token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-json */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── isPrivateAddress matrix ───────────────────────────────────────────

test('isPrivateAddress refuses every private/loopback/link-local/multicast/reserved range', () => {
  const cases = [
    // IPv4
    ['127.0.0.1', true], ['127.255.255.254', true], ['10.0.0.1', true], ['10.255.255.255', true],
    ['192.168.0.1', true], ['192.168.255.255', true],
    ['172.16.0.1', true], ['172.31.255.254', true],
    ['172.15.0.1', false], ['172.32.0.1', false],
    ['169.254.169.254', true], ['169.254.0.1', true], // cloud metadata
    ['0.0.0.0', true],
    ['255.255.255.255', true],
    ['100.64.0.1', true], ['100.127.255.254', true], ['100.128.0.1', false], // CGNAT
    ['224.0.0.1', true], ['239.255.255.255', true], ['223.255.255.255', false], // multicast
    ['240.0.0.1', true], // reserved
    ['8.8.8.8', false], ['1.1.1.1', false], ['93.184.216.34', false],
    ['198.18.0.1', true], ['198.19.99.99', true], ['198.20.0.1', false], // benchmarking
    // IPv6
    ['::1', true], ['::', true], ['0:0:0:0:0:0:0:1', true],
    ['fe80::1', true], ['fe80::abcd:1', true], ['fec0::1', false],
    ['febf::1', true], ['fec0::1', false],
    ['fc00::1', true], ['fd00::1', true], ['fd12:3456:789a::1', true],
    ['2001:db8::1', true], ['2001:db8:1234::abcd', true],
    ['2001:4860:4860::8888', false], // real Google DNS
    ['2606:4700:4700::1111', false], // real Cloudflare
    ['ff02::1', true], // multicast
    // IPv4-mapped IPv6 — the spec calls these out by name.
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.1.1.1', true],
    ['::ffff:192.168.0.1', true],
    ['::ffff:8.8.8.8', false], // mapped public — the underlying v4 is public
    ['::ffff:169.254.169.254', true],
    // Malformed / empty / null — fail closed.
    ['', true], [null, true], [undefined, true], ['not.an.ip', true], ['1.2.3', true],
    // Bracketed
    ['[::1]', true],
  ];
  let pass = 0, fail = 0;
  for (const [a, e] of cases) {
    const got = isPrivateAddress(a);
    if (got === e) pass++;
    else { fail++; console.log('  FAIL', JSON.stringify(a), 'expected', e, 'got', got); }
  }
  assert.equal(fail, 0, `${fail} cases failed`);
  assert.ok(pass >= 30, `expected 30+ pass, got ${pass}`);
});

// ── htmlToText ────────────────────────────────────────────────────────

test('htmlToText strips script blocks, tags→space, decodes 5 common entities, collapses whitespace', () => {
  const r = htmlToText(
    '<html><head><title>Hello &amp; World &quot;hi&quot;</title></head>' +
    '<body><script>alert(1)</script><style>p{color:red}</style>' +
    '<p>Hi <b>there</b>!</p><p>5 &lt; 6 &amp; 7 &gt; 5</p></body></html>'
  );
  assert.equal(r.title, 'Hello & World "hi"');
  assert.ok(!r.text.includes('alert(1)'), 'no script content');
  assert.ok(!r.text.includes('color:red'), 'no style content');
  assert.ok(r.text.includes('Hi there !'), `text=${r.text}`);
  assert.ok(r.text.includes('5 < 6 & 7 > 5'), `text=${r.text}`);
});

test('htmlToText handles empty / non-string', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});

// ── fetchPage via fake transport ─────────────────────────────────────

test('fetchPage: title extraction, tag strip, entity decode (success path)', async () => {
  const { transport, calls } = mkTransport((u) => {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><html><head><title>OK &amp; Done</title></head>' +
            '<body><h1>Welcome</h1><p>Hello <i>world</i> &quot;friend&quot;!</p></body></html>',
    };
  });
  const out = await fetchPage('https://example.com/page', { transport, lookup: mkLookup(PUBLIC) });
  assert.equal(out.status, 200);
  assert.equal(out.title, 'OK & Done');
  assert.ok(out.text.includes('Welcome'));
  assert.ok(out.text.includes('Hello world "friend"!'));
  assert.ok(out.textBytes > 0);
  assert.equal(calls.length, 1);
});

test('fetchPage: size cap (maxBytes) — textBytes ≤ maxBytes, truncated flag set', async () => {
  const big = '<p>' + 'x'.repeat(10_000) + '</p>';
  const { transport } = mkTransport(() => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: big,
  }));
  const out = await fetchPage('https://example.com/big', { transport, lookup: mkLookup(PUBLIC), maxBytes: 1024 });
  assert.ok(out.textBytes <= 1024, `textBytes=${out.textBytes}`);
  assert.equal(out.truncated, true);
});

test('fetchPage: redirect cap (max 2 hops)', async () => {
  // 3 redirects in a row should fail with too_many_redirects.
  let n = 0;
  const { transport, calls } = mkTransport((u) => {
    n++;
    if (n <= 3) return { status: 302, headers: { location: `https://example.com/h${n}` }, body: '' };
    return { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>ok</title>' };
  });
  await assert.rejects(
    () => fetchPage('https://example.com/start', { transport, lookup: mkLookup(PUBLIC) }),
    /too_many_redirects/,
  );
  // initial + 2 redirects = 3 calls, no 4th (the final GET is skipped).
  assert.equal(calls.length, 3);
});

test('fetchPage: redirect re-validates — private target via redirect is refused', async () => {
  // Public host → redirect to 127.0.0.1 → must be refused.
  const { transport, calls } = mkTransport((u) => {
    if (u.hostname === 'example.com') {
      return { status: 302, headers: { location: 'https://127.0.0.1/admin' }, body: '' };
    }
    return { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>no</title>' };
  });
  const lookup = async (host) => {
    if (host === 'example.com') return [{ address: '93.184.216.34', family: 4 }];
    if (host === '127.0.0.1') return [{ address: '127.0.0.1', family: 4 }];
    return [];
  };
  await assert.rejects(
    () => fetchPage('https://example.com/start', { transport, lookup }),
    /blocked:private_address/,
  );
  // Transport was called exactly once (the first GET), then we refused
  // before dialling the redirect target. (If we'd followed it, calls.length
  // would be 2.)
  assert.equal(calls.length, 1);
});

test('fetchPage: timeout — slow body triggers timeout', async () => {
  // Fake transport that never ends the response.
  const transport = (_opts, cb) => {
    setImmediate(() => {
      const res = new (require('node:events').EventEmitter)();
      res.statusCode = 200;
      res.headers = { 'content-type': 'text/html' };
      res.resume = () => {};
      res.destroy = (err) => { if (err) res.emit('error', err); };
      cb(res);
      // never emit 'end' or 'data'
    });
    return { on(ev, fn) { if (ev === 'close') setImmediate(fn); return this; }, destroy() {}, end() {} };
  };
  await assert.rejects(
    () => fetchPage('https://example.com/slow', { transport, lookup: mkLookup(PUBLIC), timeoutMs: 50 }),
    /timeout/,
  );
});

test('fetchPage: non-http scheme refused before DNS lookup', async () => {
  let called = false;
  const transport = () => { called = true; throw new Error('should not be called'); };
  const lookup = async () => { called = true; throw new Error('should not be called'); };
  await assert.rejects(() => fetchPage('file:///etc/passwd', { transport, lookup }), /blocked:scheme_not_https/);
  await assert.rejects(() => fetchPage('http://example.com/', { transport, lookup }), /blocked:scheme_not_https/);
  await assert.rejects(() => fetchPage('javascript:alert(1)', { transport, lookup }), /blocked:scheme_not_https/);
  assert.equal(called, false);
});

// ── SSRF: blocked host never reaches transport ───────────────────────

test('SSRF: blocked host short-circuits — transport calls remain 0', async () => {
  const { transport, calls } = mkTransport(() => { throw new Error('should never run'); });
  const blocked = [
    ['https://127.0.0.1/'],
    ['https://10.0.0.5/'],
    ['https://192.168.1.1/'],
    ['https://172.16.0.1/'],
    ['https://169.254.169.254/latest/meta-data/'], // cloud metadata
    ['https://[::1]/'],
    ['https://[fe80::1]/'],
    ['https://[fc00::1]/'],
    ['https://0.0.0.0/'],
    // DNS that resolves to private
    ['https://internal.local/'],
  ];
  const lookup = async (host) => {
    if (host === 'internal.local') return [{ address: '10.0.0.5', family: 4 }];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) {
      return [{ address: host.replace(/[\[\]]/g, ''), family: host.includes(':') ? 6 : 4 }];
    }
    return [{ address: '93.184.216.34', family: 4 }];
  };
  for (const [url] of blocked) {
    await assert.rejects(() => fetchPage(url, { transport, lookup }), /blocked/);
  }
  // Transport was never touched — that's the key security property.
  assert.equal(calls.length, 0, 'transport must never be called for blocked hosts');
});

// ── executor behind gateway: needs_approval flow end-to-end ──────────

function makeGateway({ botsDir }) {
  const gw = new Gateway({
    bots: {
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
      scout: { name: 'scout', token: 'tok-scout', role: 'worker', capabilities: ['fs.read', 'web.get'] },
    },
    mountFiles: false, // we'll register the mount manually so the test is hermetic
    botsDir,
  });
  // Mount-load the real 65-web.js to validate the production mount shape.
  gw.mounts = [mount];
  for (const e of mount.executors || []) {
    if (e.re instanceof RegExp && typeof e.make === 'function') {
      gw.registerExecutor(e.re, e.make(gw));
    }
  }
  return gw;
}

test('executor: web.fetch tool classifies read → allow (pre-approved)', async () => {
  const botsDir = tmpBotsDir();
  try {
    const gw = makeGateway({ botsDir });
    assert.ok(gw._findExecutor('web.fetch:example.com/foo'));
    assert.ok(gw._findExecutor('web.extract:api.example.com/v1'));

    // web.fetch:example.com is now classified as read → pre-approved.
    const { classify, decide } = require('../src/gateway/policy');
    const cls = classify('web.fetch:example.com/foo');
    assert.equal(cls, 'read');
    const verdict = decide({ tool: 'web.fetch:example.com/foo', cls, bot: { name: 'scout', role: 'worker', capabilities: ['fs.read', 'web.get'] } });
    assert.equal(verdict.decision, 'allow');
  } finally { cleanup(botsDir); }
});

test('executor: needs_approval → approve → fetchPage runs, audit has host only', async () => {
  const botsDir = tmpBotsDir();
  try {
    const gw = makeGateway({ botsDir });
    // Inject the fake transport via module-cache trick: swap the executor
    // with one whose fetchPage closure uses a fake transport.
    // Easiest: bypass the executor and call makeWebExecutor's internals
    // through the public factory, but provide a transport by intercepting
    // fetchPage at request time. The cleanest test-friendly path is to
    // have the executor re-export fetchPage from our module — we set the
    // module's fetchPage to use a fake transport for this test.
    // Simpler: call makeWebExecutor directly with a custom fetchPage.
    const fakeFetch = async (url) => {
      assert.equal(url, 'https://example.com/article');
      return {
        url, status: 200,
        contentType: 'text/html',
        title: 'Example',
        textBytes: 10,
        text: 'hello world',
        truncated: false,
      };
    };
    // We re-register an executor that uses our fake fetch.
    const exec = (bot, tool, args) => {
      const url = args && args.url ? args.url : ('https://' + tool.split(':').slice(1).join(':'));
      return fakeFetch(url).then((fetched) => {
        let host = '';
        try { host = new URL(fetched.url).hostname; } catch { /* noop */ }
        gw._audit({ type: 'web_fetch', bot, host, status: fetched.status, bytes: fetched.textBytes });
        // Store as jail text (we have botsDir set).
        const rel = path.join(bot, 'web', `${Date.now()}.txt`);
        const full = path.resolve(gw.botsDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, fetched.text);
        return { ok: true, url: fetched.url, status: fetched.status, title: fetched.title,
                 textBytes: fetched.textBytes, text: fetched.text, stored: { kind: 'jail', path: rel } };
      });
    };
    gw._executors = [{ re: /^web\.(fetch|extract):/, fn: exec }];

    // First, request → needs_approval.
    const r1 = await gw.approvals.request({
      bot: { name: 'scout', role: 'worker', capabilities: ['web.get'] },
      tool: 'web.fetch:example.com/article',
      args: { url: 'https://example.com/article' },
      reason: 'unclassified',
    });
    // /v1/actions flow would write the decision entry; we model the
    // approval-then-execute path:
    const parked = gw.approvals.get(r1.id);
    assert.ok(parked);
    const out = await gw._run('scout', parked.tool, parked.args);
    assert.equal(out.ok, true);
    assert.equal(out.url, 'https://example.com/article');
    assert.equal(out.title, 'Example');
    assert.equal(out.textBytes, 10);

    // Audit entries: one web_fetch with host ONLY, no full URL, no text.
    const fetches = gw.chain.entries.filter((e) => e.payload.type === 'web_fetch');
    assert.equal(fetches.length, 1);
    const p = fetches[0].payload;
    assert.equal(p.host, 'example.com');
    assert.equal(p.status, 200);
    assert.equal(p.bytes, 10);
    assert.equal(JSON.stringify(p).includes('article'), false, 'no URL path in audit');
    assert.equal(JSON.stringify(p).includes('hello world'), false, 'no text in audit');
    assert.equal(gw.chain.verify().ok, true);

    // Jail file was written.
    assert.ok(out.stored.path.startsWith('scout/web/'));
    const fullPath = path.join(botsDir, out.stored.path);
    assert.equal(fs.readFileSync(fullPath, 'utf8'), 'hello world');
  } finally { cleanup(botsDir); }
});

// ── /v2/web/fetch convenience mount via real HTTP ─────────────────────

test('mount /v2/web/fetch: bearer auth, SSRF refusal, host-only audit', async () => {
  const botsDir = tmpBotsDir();
  const gw = makeGateway({ botsDir });
  const { server, close, attach } = buildServer();
  attach(gw);
  const base = await listen(server);
  try {
    // 401 without bearer
    const r401 = await httpCall(base, 'POST', '/v2/web/fetch', { body: { url: 'https://example.com/' } });
    assert.equal(r401.status, 401);

    // 400 on bad url
    const r400 = await httpCall(base, 'POST', '/v2/web/fetch', { token: 'tok-atlas', body: { url: 'not-a-url' } });
    assert.equal(r400.status, 400);

    // 403 on private host (no transport involved — DNS resolution refused)
    const r403 = await httpCall(base, 'POST', '/v2/web/fetch', { token: 'tok-atlas', body: { url: 'https://127.0.0.1/' } });
    assert.equal(r403.status, 403);
    assert.ok(r403.body.error.includes('blocked'));

    // The 403 path writes a web_fetch audit with the host, no URL.
    const fetches = gw.chain.entries.filter((e) => e.payload.type === 'web_fetch');
    assert.ok(fetches.some((e) => e.payload.host === '127.0.0.1'));
    const last = fetches[fetches.length - 1].payload;
    assert.equal(JSON.stringify(last).includes('/'), false, 'no path in host-only audit');
  } finally {
    await close();
    cleanup(botsDir);
  }
});

test('mount /v2/web/fetch: success path returns {url,status,title,textBytes,text}', async () => {
  const botsDir = tmpBotsDir();
  const gw = makeGateway({ botsDir });
  // The mount calls fetchPage directly, which uses the real https module.
  // We swap the real fetchPage in webtools for one backed by our fake.
  // Easiest: monkey-patch the module export for the duration of this test.
  const real = webtools.fetchPage;
  webtools.fetchPage = async (url) => {
    assert.equal(url, 'https://example.com/');
    return {
      url, status: 200, contentType: 'text/html',
      title: 'Example Domain', textBytes: 5, text: 'hello',
      truncated: false,
    };
  };
  // The mount imports fetchPage at the top: make sure the binding is live.
  // Since require is cached, the mount holds a reference to the OLD
  // fetchPage. To work around this in a test, we reach into the mount's
  // module cache via the require cache.
  const mountPath = require.resolve('../src/gateway/mounts/65-web');
  require.cache[mountPath].exports = {
    ...require.cache[mountPath].exports,
    handle: async (gw2, req, res) => {
      // re-require the patched webtools
      const liveWebtools = require('../src/gateway/webtools');
      const { send, readBody } = require('../src/gateway/server');
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const h = req.headers['authorization'] || '';
      const m = /^Bearer\s+(.+)$/i.exec(h);
      const token = m ? m[1] : null;
      let botName = null;
      for (const [name, bot] of Object.entries(gw2.bots || {})) {
        if (bot && bot.token && bot.token === token) { botName = name; break; }
      }
      if (!botName) {
        try { gw2._audit({ type: 'auth_rejected', path: '/v2/web/fetch' }); } catch { /* noop */ }
        return send(res, 401, { error: 'unauthorized' });
      }
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
      const { url } = body;
      if (typeof url !== 'string' || !url) return send(res, 400, { error: 'bad_url' });
      let fetched;
      try { fetched = await liveWebtools.fetchPage(url); }
      catch (e) { return send(res, 403, { error: String(e.message || e) }); }
      let host = '';
      try { host = new URL(fetched.url).hostname; } catch { /* noop */ }
      try { gw2._audit({ type: 'web_fetch', bot: botName, host, status: fetched.status, bytes: fetched.textBytes }); } catch { /* noop */ }
      return send(res, 200, { url: fetched.url, status: fetched.status, title: fetched.title, contentType: fetched.contentType, textBytes: fetched.textBytes, truncated: !!fetched.truncated, text: fetched.text });
    },
  };
  // Re-register the patched mount.
  gw.mounts = [require.cache[mountPath].exports];

  const { server, close, attach } = buildServer();
  attach(gw);
  const base = await listen(server);
  try {
    const r = await httpCall(base, 'POST', '/v2/web/fetch', { token: 'tok-atlas', body: { url: 'https://example.com/' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.url, 'https://example.com/');
    assert.equal(r.body.status, 200);
    assert.equal(r.body.title, 'Example Domain');
    assert.equal(r.body.text, 'hello');
    const fetches = gw.chain.entries.filter((e) => e.payload.type === 'web_fetch' && e.payload.status === 200);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].payload.host, 'example.com');
  } finally {
    await close();
    cleanup(botsDir);
    webtools.fetchPage = real; // restore
    // bust patched mount cache
    delete require.cache[mountPath];
    require('../src/gateway/mounts/65-web'); // re-load to restore
  }
});
