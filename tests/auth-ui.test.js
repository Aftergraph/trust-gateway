'use strict';
// FS-A3 — client auth shell source assertions. The console auth layer
// (app/auth.js) is a browser script with no build step, so these tests pin
// its contract by source: textContent-only DOM writes, silent 401 handling,
// cookie-session preference over the bearer token, and the ?auth=signup
// deep-link. Plus live HTTP: the gateway serves /auth.js after /app.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const ROOT = process.cwd();
const APP = path.join(ROOT, 'app');
const read = (p) => fs.readFileSync(p, 'utf8');
const authJs = () => read(path.join(APP, 'auth.js'));
const indexHtml = () => read(path.join(APP, 'index.html'));

test('app/auth.js exists and index.html loads it after app.js', () => {
  assert.ok(fs.existsSync(path.join(APP, 'auth.js')), 'auth.js exists');
  const html = indexHtml();
  const appPos = html.indexOf('<script src="/app.js">');
  const authPos = html.indexOf('<script src="/auth.js">');
  assert.ok(appPos !== -1, 'index.html references /app.js');
  assert.ok(authPos !== -1, 'index.html references /auth.js');
  assert.ok(authPos > appPos, 'auth.js loads after app.js');
});

test('auth overlay is textContent-only: no innerHTML anywhere in app/auth.js', () => {
  const js = authJs();
  assert.ok(!/innerHTML/.test(js), 'the word innerHTML must not appear in app/auth.js at all');
  assert.ok(!/outerHTML/.test(js), 'no outerHTML either');
  assert.ok(!/document\.write/.test(js), 'no document.write');
  // DOM construction must go through createElement + textContent
  assert.match(js, /createElement/);
  assert.match(js, /textContent/);
});

test('auth shell is a Modal surface styled with --tg-* tokens', () => {
  const js = authJs();
  const css = read(path.join(APP, 'style.css'));
  assert.match(js, /'modal auth-modal'/, 'overlay uses the .modal surface');
  assert.match(css, /\.auth-modal/, 'auth modal styled');
  assert.match(css, /--tg-/, 'auth styles use --tg-* tokens');
  const tokenVars = css.match(/--tg-[a-z-]+/g) || [];
  assert.ok(tokenVars.length >= 5, 'auth CSS references several --tg-* tokens');
});

test('401 from /v2/auth/me is silent: no console.error/warn/alert/error throw', () => {
  const js = authJs();
  assert.match(js, /\/v2\/auth\/me/, 'probes /v2/auth/me');
  assert.match(js, /credentials/, 'sends credentials (cookie session)');
  // Silence: none of the noisy escape hatches anywhere in the file.
  assert.ok(!/console\.(error|warn|log)/.test(js), 'no console noise in app/auth.js');
  assert.ok(!/\balert\s*\(/.test(js), 'no alert()');
  // The 401 branch must be an explicitly handled, silent branch.
  assert.match(js, /status === 401/, 'explicit 401 branch');
  assert.match(js, /silent/, '401 handling documented as silent');
});

test('cookie session preferred over bearer for user-layer calls', () => {
  const js = authJs();
  assert.match(js, /hasCookieSession/, 'tracks cookie-session state');
  assert.match(js, /credentials:\s*'include'/, 'fetches include cookies');
  // The Authorization header is only attached when there is NO cookie session.
  assert.match(js, /if\s*\(!hasCookieSession\)[\s\S]{0,200}authorization/i,
    'bearer header gated behind absence of cookie session');
  // Nothing sensitive is stored client-side: no storage API calls, no cookie writes.
  assert.ok(!/localStorage\.(set|get|remove)Item|sessionStorage\.(set|get|remove)Item|indexedDB|document\.cookie\s*=/.test(js),
    'no client-side storage of credentials');
});

test('?auth=signup deep-link opens the overlay in signup mode', () => {
  const js = authJs();
  assert.match(js, /auth'\)\s*===\s*'signup'|get\('auth'\)/, 'reads the auth query param');
  assert.match(js, /openOverlay\('signup'\)/, 'opens overlay in signup mode');
  assert.match(js, /\/v2\/auth\/signup/, 'signup endpoint wired');
  assert.match(js, /\/v2\/auth\/login/, 'login endpoint wired');
  assert.match(js, /\/v2\/auth\/logout/, 'logout endpoint wired');
});

test('Sign in affordance when unauthenticated; user chip with logout when authed', () => {
  const js = authJs();
  assert.match(js, /'Sign in'/, 'Sign in affordance');
  assert.match(js, /user-chip/, 'user chip');
  assert.match(js, /'logout'/, 'logout control');
  assert.match(js, /display_name/, 'chip shows display_name');
  assert.match(js, /authChip/, 'targets the #authChip header slot');
  const html = indexHtml();
  assert.match(html, /id="authChip"/, 'header has the auth chip slot');
});

test('successful login stores nothing sensitive and refreshes console state', () => {
  const js = authJs();
  assert.match(js, /refreshConsoleState/, 'refresh hook');
  assert.match(js, /TG\.refresh|window\.TG\.refresh/, 'drives the console refresh surface');
  assert.match(js, /tg-auth-changed/, 'announces auth change to panels');
});

test('site CTAs: Open console → / and Create account → /?auth=signup', () => {
  const html = read(path.join(ROOT, 'site', 'index.html'));
  assert.match(html, /<a[^>]+href="\/"[^>]*>\s*Open console\s*<\/a>/, 'Open console CTA → /');
  assert.match(html, /<a[^>]+href="\/\?auth=signup"[^>]*>\s*Create account\s*<\/a>/, 'Create account CTA → /?auth=signup');
  // Static and honest: the site page itself still loads with no runtime auth JS.
  const siteJs = read(path.join(ROOT, 'site', 'app.js'));
  assert.ok(!/\/v2\/auth/.test(siteJs), 'site/app.js makes no auth calls — CTAs are plain links');
});

test('live HTTP: gateway serves /auth.js and the index references it', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
    dispatch: async () => ({ ok: true }),
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { authorization: 'Bearer tok-a' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', body: b }));
    }).on('error', reject);
  });
  const getNoAuth = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    }).on('error', reject);
  });
  try {
    const js = await get('/auth.js');
    assert.equal(js.status, 200, '/auth.js served');
    assert.match(js.ct, /javascript/, '/auth.js is javascript');
    const root = await get('/');
    assert.equal(root.status, 200);
    const appPos = root.body.indexOf('/app.js');
    const authPos = root.body.indexOf('/auth.js');
    assert.ok(authPos > appPos && authPos !== -1, 'served index loads auth.js after app.js');
    // Unauthenticated /v2/auth/me probe target answers 401 (or the route is
    // unmounted and falls through to auth) — never a 200 with a session.
    const me = await getNoAuth('/v2/auth/me');
    assert.notEqual(me.status, 200, '/v2/auth/me must not 200 without credentials');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
