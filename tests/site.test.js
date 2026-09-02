'use strict';
// W8 marketing site tests — serves site/ through the real Gateway static
// mount over live HTTP, plus static guarantees (XSS policy, no external
// assets, comparison facts traceable to docs/COMPARISON-2026-09-02.md).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

// node --test runs from the repo root (cwd); __dirname is unreliable there.
const ROOT = process.cwd();
const SITE = path.join(ROOT, 'site');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

test('site files exist', () => {
  for (const f of ['index.html', 'style.css', 'app.js']) {
    assert.ok(fs.existsSync(path.join(SITE, f)), f + ' exists');
  }
});

test('index.html: hero + 3 feature blocks + comparison table', () => {
  const html = read('index.html');
  assert.match(html, /workforce/i, 'mentions workforce');
  assert.match(html, /decided before/i);
  assert.match(html, /sealed after|recorded after/i);
  assert.match(html, /computer per bot|own isolated computer session/i);
  assert.match(html, /fallback/i);
  assert.match(html, /<table/, 'has comparison table');
  assert.match(html, /Grok Bot/);
  assert.match(html, /OpenBot/);
  assert.match(html, /Trust Gateway/);
  // exactly three feature articles
  const features = html.match(/<article class="feature"/g) || [];
  assert.equal(features.length, 3, 'three feature blocks');
});

test('XSS policy: no innerHTML assignment in site/app.js (textContent only)', () => {
  const js = read('app.js');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'app.js must never assign innerHTML');
  assert.ok(!/\.outerHTML\s*[+]?=/.test(js), 'no outerHTML assignment either');
  // Assert-only reference: the file itself must not contain document.write.
  assert.ok(!/document\.write/.test(js), 'no document.write');
});

test('no external assets: no src=/href= pointing at remote hosts', () => {
  const html = read('index.html');
  // Any src=" or href=" that starts with http(s):// is a remote reference — forbidden.
  const remote = html.match(/\b(src|href)\s*=\s*["']https?:\/\/[^"']*["']/gi) || [];
  assert.deepEqual(remote, [], 'no remote src/href attributes: ' + JSON.stringify(remote));
  // Also no protocol-relative //host references.
  const protoRel = html.match(/\b(src|href)\s*=\s*["']\/\/[^"']/gi) || [];
  assert.deepEqual(protoRel, [], 'no protocol-relative src/href: ' + JSON.stringify(protoRel));
  // All referenced local assets actually exist (skip anchors + remote URLs).
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const r of refs) {
    if (/^https?:|^\/\//.test(r) || r.startsWith('#')) continue;
    assert.ok(fs.existsSync(path.join(SITE, r)), 'local asset exists: ' + r);
  }
});

test('style.css: no external fonts or imports', () => {
  const css = read('style.css');
  assert.ok(!/@import/.test(css), 'no @import');
  assert.ok(!/url\(\s*["']?https?:/.test(css), 'no remote url()');
});

test('live HTTP: Gateway serves site/ at /', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: SITE,
    mountFiles: false, // site tests only exercise the static mount
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', body: b }));
    }).on('error', reject);
  });

  try {
    // Static route whitelist: /, /app.js, /style.css, /index.html
    const root = await get('/');
    assert.equal(root.status, 200);
    assert.match(root.ct, /text\/html/);
    assert.match(root.body, /workforce/i);

    const js = await get('/app.js');
    assert.equal(js.status, 200);
    assert.match(js.ct, /javascript/);

    const css = await get('/style.css');
    assert.equal(css.status, 200);
    assert.match(css.ct, /text\/css/);

    const htmlDirect = await get('/index.html');
    assert.equal(htmlDirect.status, 200);

    // Unknown path is not on the whitelist → falls through to auth (401),
    // never a marketing-page fallback.
    const missing = await get('/nope.js');
    assert.equal(missing.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('comparison copy is grounded in docs/COMPARISON-2026-09-02.md', () => {
  const doc = path.join(ROOT, 'docs', 'COMPARISON-2026-09-02.md');
  assert.ok(fs.existsSync(doc), 'comparison doc exists');
  const docText = fs.readFileSync(doc, 'utf8');
  const html = read('index.html');

  // Each key site claim must be supported by the source doc.
  const supported = [
    ['Grok Bot', /Grok Bot/],                                   // the competitor exists in the doc
    ['OpenBot', /OpenBot/],
    ['AG-UI', /AG-UI/],                                          // OpenBot's open protocol
    ['decided before', /decided\s+\*?before|kærgaranti|before/i], // governance claim in doc
    ['fallback chain', /fallback-kæde|fallback/i],               // our routing
  ];
  for (const [claim, re] of supported) {
    assert.ok(html.includes(claim), `site contains "${claim}"`);
    assert.ok(re.test(docText), `doc supports "${claim}"`);
  }
  // Grok-only-models claim: doc says "kun Grok" — site must not overstate.
  assert.ok(/Grok models only/.test(html), 'site states Grok models only');
  assert.ok(/kun Grok/.test(docText), 'doc supports Grok-only claim');
  // Shared-computer weakness for Grok Bot comes straight from the doc.
  assert.ok(/shared computer|delt/i.test(docText), 'doc mentions Grok shared computer');
  assert.ok(/Shared across bots/.test(html), 'site reflects shared-computer weakness');
  // OpenBot self-host stack from the doc.
  assert.ok(/Docker, Postgres, Bun/.test(html), 'site reflects OpenBot ops burden');
  assert.ok(/Docker, Postgres\+pgvector, Bun/.test(docText), 'doc supports ops burden');
});