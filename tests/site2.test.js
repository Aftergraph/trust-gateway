'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// FS-B3 site phase 2 tests — status.html, pricing.html, docs.html, chain
// stamp, and the extended site guarantees (textContent-only JS across the
// whole site, no remote assets anywhere, quickstart grounded in the real
// bin path, no secret material shipped in site/).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const ROOT = process.cwd();
const SITE = path.join(ROOT, 'site');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
const PAGES = ['index.html', 'status.html', 'pricing.html', 'docs.html'];

function siteFiles() {
  return fs.readdirSync(SITE).filter((f) => /\.(html|css|js)$/.test(f));
}

test('phase 2 pages exist', () => {
  for (const f of ['status.html', 'pricing.html', 'docs.html']) {
    assert.ok(fs.existsSync(path.join(SITE, f)), f + ' exists');
  }
});

test('index.html: See-it-work loop section with three illustrative snapshots', () => {
  const html = read('index.html');
  assert.match(html, /See it work/i, 'loop section present');
  assert.ok(html.includes('id="loop"'), 'loop section anchor');
  const cards = html.match(/<article class="loop-card"/g) || [];
  assert.equal(cards.length, 3, 'three loop cards (proposal, approval, sealed)');
  // The loop stages, in order: proposal -> approval -> sealed.
  const proposal = html.indexOf('approval_requested');
  const approval = html.indexOf('approval_resolved');
  const sealed = html.indexOf('action_executed_after_approval');
  assert.ok(proposal !== -1 && approval !== -1 && sealed !== -1, 'all three stage types shown');
  assert.ok(proposal < approval && approval < sealed, 'stages appear in governed order');
  // Honest labeling: every snapshot is marked illustrative.
  const labels = html.match(/Illustrative snapshot/g) || [];
  assert.ok(labels.length >= 3, 'each card labeled "Illustrative snapshot"');
  assert.match(html, /not\s+live\s+data|not live data/i, 'says the JSON is not live data');
});

test('status.html: public chain snapshot only (healthz fields, nothing sensitive)', () => {
  const html = read('status.html');
  assert.ok(html.includes('/healthz'), 'references the public endpoint');
  assert.ok(html.includes('id="chain-state"'), 'seal state element');
  assert.ok(html.includes('id="chain-count"'), 'entry count element');
  // The page must promise public-only fields and say nothing sensitive is shown.
  assert.match(html, /[Nn]othing sensitive/, 'states the public-data boundary');
  // It must not name real bots, tokens, or internal endpoints beyond the public ones.
  assert.ok(!/BOT_TOKENS|TG_LLM_KEY|api[_-]?key/i.test(html), 'no credential material');
});

test('pricing.html: three tiers grounded in product reality, contact-only prices', () => {
  const html = read('pricing.html');
  for (const tier of ['Operator', 'Team', 'Hosted']) {
    assert.ok(html.includes(tier), 'tier present: ' + tier);
  }
  // Grounded claims — each maps to a real, tested product property.
  assert.match(html, /zero-dependency|Node core only/i, 'zero-dep gateway claim');
  assert.match(html, /jail|jailed|isolated/i, 'per-bot jail claim');
  assert.match(html, /hash-chained|sealed/i, 'sealed chain claim');
  // Prices are placeholders — and we never invent numbers.
  const prices = html.match(/<p class="price">[^<]*<\/p>/g) || [];
  assert.equal(prices.length, 3, 'three price slots');
  for (const p of prices) assert.match(p, /[Cc]ontact/, 'price is a contact placeholder: ' + p);
  assert.ok(!/\$\s?\d/.test(html), 'no dollar amounts');
  assert.ok(!/\b\d[\d.,]*\s?(USD|EUR|DKK|kr\b)/i.test(html), 'no currency amounts');
  assert.match(html, /[Ww]e would rather show no number than an invented one|not published yet/, 'honesty note');
});

test('docs.html: quickstart matches the real entrypoint and env flow', () => {
  const html = read('docs.html');
  // The real binary path — assert against the actual repo layout, not a string.
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'gateway.js')), 'bin/gateway.js really exists');
  assert.ok(html.includes('node bin/gateway.js'), 'quickstart runs the real bin path');
  assert.ok(html.includes('--dispatch'), 'quickstart enables the jailed dispatcher');
  assert.ok(html.includes('source data/gateway.env'), 'quickstart sources the env file');
  assert.ok(html.includes('data/gateway.env'), 'env file path matches deploy/cloud.md');
  assert.ok(html.includes('localhost:8800'), 'console URL matches default PORT 8800');
  // Public-safe API table: the two unauthenticated routes + token-gated ones.
  assert.ok(html.includes('/healthz'), 'healthz listed');
  assert.ok(html.includes('/v1/actions'), 'actions listed');
  assert.ok(html.includes('/v1/approvals'), 'approvals listed');
  assert.ok(html.includes('/v1/audit/verify'), 'verify listed');
  // /v1/audit/verify sits behind the auth wall — the table must not call it public.
  const verifyRow = html.slice(html.indexOf('/v1/audit/verify') - 200, html.indexOf('/v1/audit/verify') + 300);
  assert.match(verifyRow, /[Bb]earer bot token/, 'verify endpoint marked as token-gated');
  // No real credentials in the quickstart — placeholders only.
  assert.ok(!/:[A-Za-z0-9]{16,}/.test(html), 'no token-looking values');
});

test('chain stamp: every page has the footer stamp; site JS reads /healthz client-side', () => {
  for (const f of PAGES) {
    const html = read(f);
    assert.ok(html.includes('id="chain-stamp"'), f + ' has footer chain stamp');
    assert.ok(html.includes('src="app.js"'), f + ' loads site app.js');
  }
  const js = read('app.js');
  assert.ok(js.includes("fetch('/healthz'"), 'stamp fetches the public endpoint');
  assert.ok(js.includes("getElementById('chain-stamp'"), 'writes into the stamp');
});

test('XSS policy: all site JS is textContent-only (no innerHTML/outerHTML/insertAdjacentHTML)', () => {
  const jsFiles = siteFiles().filter((f) => f.endsWith('.js'));
  assert.ok(jsFiles.length >= 1, 'site JS files found');
  for (const f of jsFiles) {
    const js = read(f);
    assert.ok(!/\.innerHTML\s*[+]?=/.test(js), f + ': no innerHTML assignment');
    assert.ok(!/\.outerHTML\s*[+]?=/.test(js), f + ': no outerHTML assignment');
    assert.ok(!/insertAdjacentHTML/.test(js), f + ': no insertAdjacentHTML');
    assert.ok(!/document\.write/.test(js), f + ': no document.write');
  }
});

test('no external assets anywhere in site/ (no @import, no remote src/href/url)', () => {
  for (const f of siteFiles()) {
    const text = read(f);
    if (f.endsWith('.css')) {
      assert.ok(!/@import/.test(text), f + ': no @import');
      assert.ok(!/url\(\s*["']?https?:/i.test(text), f + ': no remote url()');
    }
    if (f.endsWith('.html')) {
      const remote = text.match(/\b(src|href)\s*=\s*["']https?:\/\/[^"']*["']/gi) || [];
      assert.deepEqual(remote, [], f + ': no remote src/href');
      const protoRel = text.match(/\b(src|href)\s*=\s*["']\/\/[^"']/gi) || [];
      assert.deepEqual(protoRel, [], f + ': no protocol-relative src/href');
      // Local refs resolve to real files (root-relative refs are served by the
      // gateway itself — /healthz, /home/*; skip those).
      const refs = [...text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const r of refs) {
        if (/^https?:|^\/\//.test(r) || r.startsWith('/') || r.startsWith('#')) continue;
        const file = r.split('#')[0];
        if (!file) continue; // pure in-page fragment on a local file
        assert.ok(fs.existsSync(path.join(SITE, file)), f + ': local asset exists: ' + r);
      }
    }
  }
});

test('token block: site/style.css carries the --tg-* design tokens, independent of app/', () => {
  const css = read('style.css');
  assert.ok(!/@import/.test(css), 'site css stays dependency-free');
  for (const token of ['--tg-bg-base', '--tg-state-ok', '--tg-risk-destructive', '--tg-radius-pill']) {
    assert.ok(css.includes(token + ':'), 'token present: ' + token);
  }
  // Copied from app/style.css :root — same literal values, no shared file.
  const appCss = fs.readFileSync(path.join(ROOT, 'app', 'style.css'), 'utf8');
  const grab = (text) => (text.match(/--tg-bg-base:\s*([^\s;]+)/) || [])[1];
  assert.equal(grab(css), grab(appCss), 'token values match the app design system');
});

test('no secret material anywhere in site/', () => {
  for (const f of siteFiles()) {
    const text = read(f);
    // Placeholder-bearing env lines are fine; anything that looks like a
    // real token value is not. BOT_TOKENS lines must only carry placeholders.
    const envLines = text.match(/BOT_TOKENS=[^\s<]+/g) || [];
    for (const line of envLines) {
      assert.match(line, /your-|placeholder|example/i, f + ': token values are placeholders: ' + line);
    }
    assert.ok(!/TG_LLM_KEY\s*=\s*(?!\*\*\*|your|placeholder|\$\{)/i.test(text), f + ': no LLM key value');
    assert.ok(!/[A-Fa-f0-9]{64}/.test(text), f + ': no full 64-hex hash (real head or token)');
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY/.test(text), f + ': no private key material');
  }
});

test('live HTTP: Gateway serves the new pages at /home/* and /healthz snapshot shape', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    marketingDir: SITE,
    mountFiles: false,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res2) => {
      let b = '';
      res2.on('data', (c) => (b += c));
      res2.on('end', () => resolve({ status: res2.statusCode, ct: res2.headers['content-type'] || '', body: b }));
    }).on('error', reject);
  });

  try {
    for (const p of ['/home', '/home/status.html', '/home/pricing.html', '/home/docs.html']) {
      const r = await get(p);
      assert.equal(r.status, 200, p + ' serves 200');
      assert.match(r.ct, /text\/html/, p + ' is html');
    }
    // Relative asset rewrite keeps /home/* self-contained.
    const status = await get('/home/status.html');
    assert.ok(status.body.includes('/home/style.css'), 'style ref rewritten for /home');
    assert.ok(status.body.includes('/home/app.js'), 'script ref rewritten for /home');

    // The endpoint the status page consumes — public, no auth.
    const hz = await get('/healthz');
    assert.equal(hz.status, 200);
    const data = JSON.parse(hz.body);
    assert.equal(data.ok, true);
    assert.equal(data.chain.ok, true, 'chain verifies');
    assert.equal(typeof data.chain.length, 'number', 'entry count present');
    assert.equal(typeof data.chain.head, 'string', 'chain head present');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
