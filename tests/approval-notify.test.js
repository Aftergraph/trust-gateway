// D2 TDD — Telegram-notify ved pending approvals (fire-and-forget, fail-open).
// Når en approval parkeres (audit: action_decision decision=needs_approval),
// notifieres konfigureret chatId hvis TG_TELEGRAM_TOKEN + TG_NOTIFY_CHAT_ID sat.
// Fejl (netværk/401) swallowes med audit — ALDRIG bryder approval-flowet.
// Testen injicerer fetch-stub i telegram-adapteren (samme konvention som 71-tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_NOTIFY_CHAT_ID = '12345';
process.env.TG_TELEGRAM_TOKEN = 'test-token';
process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-d2-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-d2-rooms-')), 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const notifyMount = require('../src/gateway/approval-notify.js');

test('D2: mount registreret + konfig-kontrakt', () => {
  assert.equal(notifyMount.name, 'approval-notify');
  assert.equal(typeof notifyMount.wire, 'function');
});

test('D2: wire() sender notify ved needs_approval-audit, swallow-fejl', async () => {
  // stub fetch i telegram-adapteren (globalThis.fetch — adapteren bruger den som default)
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url).slice(0, 60), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const calls = [];
  const gw = { _audit: (e) => calls.push(e), now: () => Date.now(), bots: {} };
  const notify = notifyMount.wire(gw);
  // simuler needs_approval-audit
  notify({ type: 'action_decision', decision: 'needs_approval', bot: 'forge', tool: 'fs.delete:x' });
  // vent på fire-and-forget promise
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1, 'telegram sendt');
  assert.match(sent[0].body.text, /approval/i);
  assert.ok(calls.some((e) => e.type === 'approval_notify_sent'), 'audit: sent');

  // netværksfejl swallowes + audit
  globalThis.fetch = async () => { throw new Error('net down'); };
  notify({ type: 'action_decision', decision: 'needs_approval', bot: 'forge', tool: 'fs.delete:y' });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(calls.some((e) => e.type === 'approval_notify_failed'), 'audit: failed (fail-open)');

  // andre decisions ignoreres
  const before = sent.length;
  globalThis.fetch = async (url, opts) => { sent.push(1); return { ok: true, json: async () => ({}) }; };
  notify({ type: 'action_decision', decision: 'allow', bot: 'forge', tool: 'fs.read:x' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, before, 'allow → ingen notify');

  globalThis.fetch = origFetch;
});
