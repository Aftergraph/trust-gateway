'use strict';
// §20 — global near-limit alert badge (app/alert-badge.js): kontrakttests.
// 24h-tæller ved boot, live-inkrement pr. rate_bucket_near_limit-frame via
// TG_EVENTS, klik → jumpTab('rate'), textContent-only, skjult ved 0.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BADGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'alert-badge.js'), 'utf8');

function domNode(tag) {
  const children = [];
  return {
    tagName: tag,
    className: '',
    textContent: '',
    children,
    classList: {
      values: new Set(),
      add(c) { this.values.add(c); },
      remove(c) { this.values.delete(c); },
      toggle(c, on) { if (on) this.values.add(c); else this.values.delete(c); },
      contains(c) { return this.values.has(c); },
    },
    appendChild(n) { children.push(n); return n; },
    addEventListener(ev, fn) { this._listeners = this._listeners || {}; this._listeners[ev] = fn; },
    click() { if (this._listeners && this._listeners.click) this._listeners.click(); },
  };
}

function makeSandbox({ apiResult = { total: 3 } } = {}) {
  const apiCalls = [];
  const auditListeners = new Set();
  const win = {
    TG: { api: async (u) => { apiCalls.push(u); return apiResult; } },
    TG_EVENTS: {
      onAudit(fn) { auditListeners.add(fn); return () => auditListeners.delete(fn); },
      onAuthExpired() { return () => {}; },
      open() {},
    },
    TG_CORE: { switchTab: (id) => { win._jumped = id; } },
  };
  const strip = domNode('#nowQueue');
  const sandbox = {
    window: win,
    document: { getElementById: (id) => (id === 'nowQueue' ? strip : null), createElement: (t) => domNode(t), createTextNode: (t) => ({ textContent: t }) },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(BADGE, sandbox, { filename: 'alert-badge.js' });
  return { win, strip, apiCalls, auditListeners };
}

test('S20: badge injiceres i NOW-stripet med 24h-tæller fra federation-audit', async () => {
  const { win, strip, apiCalls } = makeSandbox({ apiResult: { total: 3 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(strip.children.length >= 1, 'badge-element tilføjet til #nowQueue');
  const badge = strip.children[0];
  assert.equal(badge.className, 'alert-badge');
  assert.ok(apiCalls.some((u) => u.includes('/v2/federation/audit/events?type=rate_bucket_near_limit&since=')),
    'boot henter 24h-tæller: ' + apiCalls.join('|'));
  assert.ok(!badge.classList.contains('hidden'), 'total=3 → badge synlig');
  // tælleren står i <b>
  assert.ok(badge.children.length >= 1 && badge.children[0].tagName === 'b', 'tæller i <b>');
});

test('S20: live-inkrement pr. near-limit-frame via TG_EVENTS', async () => {
  const { win, strip, auditListeners } = makeSandbox({ apiResult: { total: 2 } });
  await new Promise((r) => setTimeout(r, 10));
  const badge = strip.children[0];
  const b = badge.children[0];
  assert.equal(b.textContent, '2', 'boot-tæller viser 24h-total');
  // simulér en ny seal-frame
  for (const fn of auditListeners) fn({ payload: { type: 'rate_bucket_near_limit' } });
  assert.equal(b.textContent, '3', 'frame inkermenterer badge');
  // ikke-near-limit-frame rører ikke tælleren
  for (const fn of auditListeners) fn({ payload: { type: 'action_allowed' } });
  assert.equal(b.textContent, '3');
});

test('S20: klik på badge åbner Rate-panelet (jumpTab)', async () => {
  const { win, strip } = makeSandbox({ apiResult: { total: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  strip.children[0].click();
  assert.equal(win._jumped, 'rate', 'klik → TG_CORE.switchTab("rate")');
});

test('S20: tæller 0 → badge skjult (hidden) — ingen gul støj uden alerts', async () => {
  const { win, strip } = makeSandbox({ apiResult: { total: 0 } });
  await new Promise((r) => setTimeout(r, 10));
  const badge = strip.children[0];
  assert.ok(badge.classList.contains('hidden'), '0 alerts → skjult');
});

test('S20: XSS-politik — textContent-only, ingen element-html-APIer', () => {
  assert.ok(!BADGE.includes('innerHTML'), 'textContent-only');
  assert.ok(!BADGE.includes('insertAdjacentHTML'));
});