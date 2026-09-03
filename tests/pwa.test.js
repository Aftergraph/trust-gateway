'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app');

test('PWA files exist in app/', () => {
  for (const f of [
    'sw.js',
    'manifest.webmanifest',
    'offline.html',
    'responsive.css',
    'desktop.css',
    'pwa-head.html',
    path.join('icons', 'icon-192.svg'),
    path.join('icons', 'icon-512.svg'),
    path.join('icons', 'icon-maskable.svg'),
  ]) {
    assert.ok(fs.existsSync(path.join(APP, f)), f + ' exists');
  }
});

test('sw.js is syntax-valid JavaScript', () => {
  const src = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
  assert.doesNotThrow(() => new Function(src), 'sw.js must parse');
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'sw.js' }), 'vm.Script parse');
});

test('sw.js cache strategy + API bypass + offline fallback', () => {
  const src = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
  assert.match(src, /VERSION\s*=/, 'has a version constant');
  assert.match(src, /addEventListener\(\s*['"]install['"]/, 'install handler');
  assert.match(src, /addEventListener\(\s*['"]activate['"]/, 'activate handler');
  assert.match(src, /addEventListener\(\s*['"]fetch['"]/, 'fetch handler');
  assert.match(src, /\/v1\//, 'v1 API routing');
  assert.match(src, /\/v2\//, 'v2 API routing');
  assert.match(src, /offline\.html/, 'offline fallback');
  assert.match(src, /caches\.match/, 'cache-first shell reads');
});

test('sw.js registers expected shell assets', () => {
  const src = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
  for (const asset of ['/index.html', '/app.js', '/style.css', '/responsive.css', '/desktop.css', '/offline.html', '/manifest.webmanifest']) {
    assert.ok(src.includes("'" + asset + "'"), 'shell asset listed: ' + asset);
  }
});

test('manifest parses as JSON with required fields + icons', () => {
  const raw = fs.readFileSync(path.join(APP, 'manifest.webmanifest'), 'utf8');
  let m;
  assert.doesNotThrow(() => { m = JSON.parse(raw); }, 'valid JSON');
  assert.equal(m.name, 'Trust Gateway');
  assert.ok(m.short_name, 'short_name');
  assert.equal(m.display, 'standalone');
  assert.ok(m.start_url !== undefined, 'start_url');
  assert.ok(m.scope !== undefined, 'scope');
  assert.ok(m.background_color, 'background_color');
  assert.ok(m.theme_color, 'theme_color');
  // dark theme colors
  const c = (s) => s.replace('#', '');
  assert.match(c(m.background_color), /^[0-9a-fA-F]{6}$/);
  assert.match(c(m.theme_color), /^[0-9a-fA-F]{6}$/);
  // icons array with src + sizes + type
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 1, 'icons array');
  for (const ic of m.icons) {
    assert.ok(ic.src && ic.sizes && ic.type, 'icon entry complete');
    assert.ok(fs.existsSync(path.join(APP, ic.src.replace(/^\//, ''))), 'icon file exists: ' + ic.src);
  }
});

test('icons are valid hand-built SVG (no binaries)', () => {
  const iconsDir = path.join(APP, 'icons');
  const files = fs.readdirSync(iconsDir);
  assert.ok(files.length >= 2, 'at least two icons');
  for (const f of files) {
    assert.match(f, /\.svg$/, 'icon must be svg: ' + f);
    const src = fs.readFileSync(path.join(iconsDir, f), 'utf8');
    assert.match(src, /^<\?xml|<svg/, 'svg root present');
    assert.doesNotThrow(() => {
      // parse via vm-free regex sanity: xmlns + viewBox + closing tag
      assert.match(src, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match(src, /viewBox=/);
      assert.match(src, /<\/svg>/);
    }, 'svg structure for ' + f);
  }
});

test('offline.html exists and is self-contained', () => {
  const html = fs.readFileSync(path.join(APP, 'offline.html'), 'utf8');
  assert.match(html, /<html/i);
  assert.match(html, /Trust Gateway/i);
  assert.match(html, /offline/i);
});

test('responsive.css: mobile rules, dvh units, 44px tap targets, safe-area', () => {
  const css = fs.readFileSync(path.join(APP, 'responsive.css'), 'utf8');
  assert.match(css, /dvh/, 'dvh units');
  assert.match(css, /44px/, '44px tap targets');
  assert.match(css, /safe-area-inset/, 'safe-area insets');
  assert.match(css, /grid-template-columns:\s*1fr/, 'single-column panes');
  assert.match(css, /@media/, 'has responsive breakpoints');
});

test('desktop.css: wide-screen grid keeps the 3-pane contract + keyboard hints', () => {
  const css = fs.readFileSync(path.join(APP, 'desktop.css'), 'utf8');
  // FE1: wide screens must NOT promote #paneWorkforce children out of the
  // pane (display:contents detached the WORKFORCE title from its body).
  assert.ok(!/display:\s*contents/.test(css), 'no display:contents pane splitting');
  assert.match(css, /grid-template-columns:\s*1\.2fr 1fr 1fr/, '3-col grid (base contract)');
  assert.match(css, /kbd/, 'keyboard hints');
});

test('pwa-head.html fragment lists the tags the orchestrator must wire', () => {
  const frag = fs.readFileSync(path.join(APP, 'pwa-head.html'), 'utf8');
  assert.match(frag, /manifest\.webmanifest/);
  assert.match(frag, /sw\.js/);
  assert.match(frag, /responsive\.css/);
  assert.match(frag, /desktop\.css/);
});

test('sw.js + manifest are static-safe (no server-side secrets, no innerHTML)', () => {
  const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
  const offline = fs.readFileSync(path.join(APP, 'offline.html'), 'utf8');
  const frag = fs.readFileSync(path.join(APP, 'pwa-head.html'), 'utf8');
  for (const [name, src] of [['sw.js', sw], ['offline.html', offline], ['pwa-head.html', frag]]) {
    assert.ok(!/\.innerHTML\s*[+]?=/.test(src), name + ' must never assign innerHTML');
    assert.ok(!/Bearer\s+[A-Za-z0-9]{8,}/.test(src), name + ' must not embed tokens');
  }
});