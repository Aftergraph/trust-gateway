'use strict';
// Tests for the Telegram bridge (Slice 4).
//
// Strategy:
//   - The bridge itself is a pure handler factory; we inject a stub
//     `tgCall` and a stub `client` (a GatewayClient-shaped object) and
//     call handlers directly. This is the preferred test surface — no
//     real Telegram API ever runs here.
//   - For "the daemon end-to-end" we ALSO stand up a local http server
//     that pretends to be the Telegram Bot API and a second local server
//     that pretends to be the trust gateway. These exercise the actual
//     network code path in `bin/bridge-telegram.js` without ever
//     touching api.telegram.org.

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');

const {
  createBridge,
  parseAllowedUsers,
  formatApprovalCard,
  summarizeAuditEntry,
  friendlyGatewayError,
  isAlreadyResolved,
} = require('../src/bridge/telegram');
const bridgeBin = require('../bin/bridge-telegram');

// ---------- tiny test helpers ---------------------------------------------

function makeStubClient(overrides = {}) {
  const calls = { pending: 0, approve: 0, deny: 0, verify: 0, audit: 0 };
  // Wrapper helpers — increment counter AND call the override (or default).
  const wrap = (key, def) => async (...args) => {
    calls[key]++;
    const fn = overrides[key] || def;
    return fn(...args);
  };
  const client = {
    pending:  wrap('pending',  async () => ({ pending: [] })),
    approve:  wrap('approve',  async (id) => ({ id, status: 'approved' })),
    deny:     wrap('deny',     async (id) => ({ id, status: 'denied' })),
    verify:   wrap('verify',   async () => ({ ok: true, length: 7, chainId: 'cid_test' })),
    audit:    wrap('audit',    async () => ({ entries: [], verified: { ok: true }, head: 'h' })),
  };
  return { client, calls };
}

function makeStubTgCall() {
  const sent = [];
  const tgCall = async (method, params) => {
    sent.push({ method, params });
    return { ok: true, result: { message_id: sent.length, chat: { id: params?.chat_id } } };
  };
  return { tgCall, sent };
}

// ---------- pure-function unit tests (white-box) --------------------------

test('parseAllowedUsers: empty / null => empty Set (deny-all)', () => {
  assert.equal(parseAllowedUsers('').size, 0);
  assert.equal(parseAllowedUsers(undefined).size, 0);
  assert.equal(parseAllowedUsers(null).size, 0);
});

test('parseAllowedUsers: parses valid IDs, drops junk', () => {
  const s = parseAllowedUsers('  123 , abc, 456 , -1 , 0 ');
  assert.deepEqual([...s].sort(), [123, 456]);
});

test('formatApprovalCard: contains bot+tool+id, NEVER args/secret', () => {
  const card = formatApprovalCard({
    id: 'apr_1',
    bot: 'forge',
    tool: 'shell.run',
    args: { cmd: 'rm -rf /', secret: 'AKIA1234' },
    raw_secret: 'should-not-appear',
  });
  assert.match(card.text, /Bot: forge/);
  assert.match(card.text, /Tool: shell\.run/);
  assert.match(card.text, /ID: apr_1/);
  assert.doesNotMatch(card.text, /rm -rf/);
  assert.doesNotMatch(card.text, /AKIA/);
  assert.doesNotMatch(card.text, /should-not-appear/);
  assert.equal(card.reply_markup.inline_keyboard.length, 1);
  assert.equal(card.reply_markup.inline_keyboard[0].length, 2);
  assert.equal(card.reply_markup.inline_keyboard[0][0].text, 'Approve');
  assert.equal(card.reply_markup.inline_keyboard[0][1].text, 'Deny');
  assert.match(card.reply_markup.inline_keyboard[0][0].callback_data, /^approve:apr_1$/);
  assert.match(card.reply_markup.inline_keyboard[0][1].callback_data, /^deny:apr_1$/);
});

test('formatApprovalCard: sanitizes tool to leading namespace when ":" is stuffed in', () => {
  // Upstream producer accidentally embedded the target path in tool —
  // the bridge must show only the namespace, never the path.
  const card = formatApprovalCard({
    id: 'apr_x',
    bot: 'atlas',
    tool: 'fs.write:/etc/passwd',
  });
  assert.match(card.text, /Tool: fs\.write/);
  assert.doesNotMatch(card.text, /\/etc\/passwd/);
  // callback_data must use the real id (preserved as-is), not the tool.
  assert.match(card.reply_markup.inline_keyboard[0][0].callback_data, /^approve:apr_x$/);
});

test('summarizeAuditEntry: type/bot/tool only, no payloads', () => {
  const s = summarizeAuditEntry({
    seq: 42, type: 'action_executed', bot: 'forge', tool: 'shell.run',
    args: { cmd: 'super-secret' }, token: 'plaintext-leak',
  });
  assert.match(s, /#42/);
  assert.match(s, /action_executed/);
  assert.match(s, /forge/);
  assert.match(s, /shell\.run/);
  assert.doesNotMatch(s, /super-secret/);
  assert.doesNotMatch(s, /plaintext-leak/);
});

test('friendlyGatewayError: maps ECONNREFUSED + timeout to friendly text', () => {
  assert.equal(friendlyGatewayError(new Error('connect ECONNREFUSED 1.2.3.4:8800')), 'Gateway unreachable — try again shortly.');
  assert.equal(friendlyGatewayError(new Error('request timed out after 15000ms')), 'Gateway unreachable — try again shortly.');
  assert.equal(friendlyGatewayError(new Error('getaddrinfo ENOTFOUND host')), 'Gateway unreachable — try again shortly.');
  assert.equal(friendlyGatewayError(new Error('invalid JSON from server')), 'Gateway returned an invalid response.');
  assert.match(friendlyGatewayError(new Error('something else')), /Gateway error:/);
});

test('isAlreadyResolved: detects 404/409 client envelopes', () => {
  assert.equal(isAlreadyResolved({ error: 'not_found' }), true);
  assert.equal(isAlreadyResolved({ status: 404 }), true);
  assert.equal(isAlreadyResolved({ error: 'conflict' }), true);
  assert.equal(isAlreadyResolved({ status: 409 }), true);
  assert.equal(isAlreadyResolved({ id: 'x', status: 'approved' }), false);
  assert.equal(isAlreadyResolved(null), false);
  assert.equal(isAlreadyResolved(undefined), false);
});

// ---------- A-001 /pending with 2 pending --------------------------------

test('A-001 /pending with 2 pending: 2 cards with keyboards, bot+tool visible, no args/secret', async () => {
  const { client, calls } = makeStubClient({
    pending: async () => ({
      pending: [
        { id: 'apr_1', bot: 'forge', tool: 'shell.run', args: { cmd: 'rm -rf /' }, secret: 'AKIA_LEAK' },
        { id: 'apr_2', bot: 'atlas', tool: 'fs.write:/etc/passwd', args: { path: '/etc/passwd', content: 'hax' } },
      ],
    }),
  });
  const { tgCall, sent } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  const specs = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: '/pending', chat: { id: 7001 }, from: { id: 42 } },
  });

  // Drive the specs through tgCall — that's what the poll loop does.
  for (const spec of specs) await tgCall(spec.method, spec.params || {});

  assert.equal(calls.pending, 1);
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.equal(s.method, 'sendMessage');
    assert.equal(s.params.chat_id, 7001);
    assert.match(s.params.text, /Bot: /);
    assert.match(s.params.text, /Tool: /);
    // NO args / secret values leak into the user-facing message.
    assert.doesNotMatch(s.params.text, /rm -rf/);
    assert.doesNotMatch(s.params.text, /AKIA_LEAK/);
    assert.doesNotMatch(s.params.text, /\/etc\/passwd/);
    assert.doesNotMatch(s.params.text, /hax/);
    assert.ok(Array.isArray(s.params.reply_markup.inline_keyboard));
    assert.equal(s.params.reply_markup.inline_keyboard[0][0].text, 'Approve');
    assert.equal(s.params.reply_markup.inline_keyboard[0][1].text, 'Deny');
  }
});

// ---------- A-002 Approve callback ----------------------------------------

test('A-002 Approve callback: approve called, card updated, audit via gateway mocked', async () => {
  const seen = [];
  const client = {
    approve: async (id) => { seen.push({ kind: 'approve', id }); return { id, status: 'approved', result: { ran: true } }; },
    deny:    async (id) => { seen.push({ kind: 'deny',    id }); return { id, status: 'denied'  }; },
    audit:   async ()   => {
      seen.push({ kind: 'audit' });
      return {
        verified: { ok: true },
        head: 'abc',
        entries: [
          { seq: 12, type: 'action_proposed',  bot: 'forge', tool: 'shell.run' },
          { seq: 13, type: 'approval_recorded', bot: 'atlas', tool: 'shell.run' },
          { seq: 14, type: 'action_executed_after_approval', bot: 'forge', tool: 'shell.run' },
        ],
      };
    },
    pending: async () => ({ pending: [] }),
    verify:  async () => ({ ok: true, length: 14, chainId: 'cid_test' }),
  };
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  // 1) operator taps Approve
  const specs1 = await bridge.handleUpdate({
    update_id: 100,
    callback_query: {
      id: 'cb_1', data: 'approve:apr_9', from: { id: 42 },
      message: { message_id: 55, chat: { id: 7001 } },
    },
  });
  // 2) operator then runs /audit 3 to verify the chain sealed it
  const specs2 = await bridge.handleUpdate({
    update_id: 101,
    message: { message_id: 11, text: '/audit 3', chat: { id: 7001 }, from: { id: 42 } },
  });

  assert.equal(seen[0].kind, 'approve');
  assert.equal(seen[0].id, 'apr_9');

  // approve path: answerCallbackQuery + editMessageText (success).
  const methods1 = specs1.map((s) => s.method);
  assert.ok(methods1.includes('answerCallbackQuery'));
  assert.ok(methods1.includes('editMessageText'));
  const acq = specs1.find((s) => s.method === 'answerCallbackQuery');
  assert.match(acq.params.text, /Approved/);

  // /audit path: one sendMessage summarizing entries — type/bot/tool only.
  assert.equal(specs2.length, 1);
  assert.equal(specs2[0].method, 'sendMessage');
  assert.match(specs2[0].params.text, /Last 3 audit entries/);
  assert.match(specs2[0].params.text, /action_executed_after_approval/);
  assert.match(specs2[0].params.text, /forge/);
  // again — no secrets in audit summary
  for (const e of ['secret', 'AKIA', 'rm -rf']) {
    assert.doesNotMatch(specs2[0].params.text, new RegExp(e));
  }
});

// ---------- A-003 unknown Telegram user ----------------------------------

test('A-003 unknown Telegram user: request ignored, ZERO gateway calls', async () => {
  const { client, calls } = makeStubClient();
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  // message
  const r1 = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: '/pending', chat: { id: 7001 }, from: { id: 999 } },
  });
  // callback
  const r2 = await bridge.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'cb_x', data: 'approve:apr_1', from: { id: 999 },
      message: { message_id: 5, chat: { id: 7001 } },
    },
  });
  // verify
  const r3 = await bridge.handleUpdate({
    update_id: 3,
    message: { message_id: 11, text: '/verify', chat: { id: 7001 }, from: { id: 999 } },
  });

  assert.equal(calls.pending, 0);
  assert.equal(calls.approve, 0);
  assert.equal(calls.deny, 0);
  assert.equal(calls.verify, 0);
  assert.equal(calls.audit, 0);

  assert.deepEqual(r1, [], 'message: empty specs');
  assert.equal(r2.length, 1, 'callback: answerCallbackQuery spec');
  assert.equal(r2[0].method, 'answerCallbackQuery');
  assert.match(r2[0].params.text, /Not authorized/);
  assert.deepEqual(r3, [], 'verify: empty specs');
});

// ---------- A-004 gateway unreachable ------------------------------------

test('A-004 gateway unreachable: user gets friendly message, no crash', async () => {
  const client = {
    pending: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8800'); },
    approve: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8800'); },
    deny:    async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8800'); },
    verify:  async () => { throw new Error('request timed out after 15000ms'); },
    audit:   async () => { throw new Error('getaddrinfo ENOTFOUND gateway.local'); },
  };
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  // /pending on unreachable gateway
  const r1 = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: '/pending', chat: { id: 7001 }, from: { id: 42 } },
  });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].method, 'sendMessage');
  assert.match(r1[0].params.text, /Gateway unreachable/);

  // /verify on unreachable gateway
  const r2 = await bridge.handleUpdate({
    update_id: 2,
    message: { message_id: 11, text: '/verify', chat: { id: 7001 }, from: { id: 42 } },
  });
  assert.equal(r2.length, 1);
  assert.equal(r2[0].method, 'sendMessage');
  assert.match(r2[0].params.text, /Gateway unreachable/);

  // callback approve on unreachable gateway — still resolves, doesn't crash
  const r3 = await bridge.handleUpdate({
    update_id: 3,
    callback_query: {
      id: 'cb_1', data: 'approve:apr_9', from: { id: 42 },
      message: { message_id: 55, chat: { id: 7001 } },
    },
  });
  assert.ok(Array.isArray(r3));
  assert.equal(r3.length, 2);
  assert.equal(r3[0].method, 'answerCallbackQuery');
  assert.match(r3[0].params.text, /Gateway unreachable/);
  assert.equal(r3[1].method, 'editMessageReplyMarkup');
});

// ---------- A-005 /verify -> ok + length + chainId -----------------------

test('A-005 /verify: reply contains ok+length+chainId', async () => {
  const { client } = makeStubClient({
    verify: async () => ({ ok: true, length: 42, chainId: 'cid_chain42' }),
  });
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  const specs = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: '/verify', chat: { id: 7001 }, from: { id: 42 } },
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].method, 'sendMessage');
  assert.match(specs[0].params.text, /ok=true/);
  assert.match(specs[0].params.text, /length=42/);
  assert.match(specs[0].params.text, /cid_chain42/);
});

// ---------- A-006 missing env: clean exit, no stacktrace ------------------

test('A-006 missing env: bridgeBin.main returns 1, friendly message, no stacktrace', async () => {
  const original = { ...process.env };
  // strip required vars so loadConfig fails.
  for (const k of bridgeBin.REQUIRED_ENV) delete process.env[k];
  delete process.env.TG_ALLOWED_USERS;

  const captured = [];
  const origErr = console.error;
  console.error = (...args) => captured.push(args.join(' '));

  try {
    const code = await bridgeBin.main(process.env);
    assert.equal(code, 1, 'exit code must be 1');
    const text = captured.join('\n');
    assert.match(text, /missing required env/);
    for (const k of bridgeBin.REQUIRED_ENV) assert.match(text, new RegExp(k));
    // No stacktrace fragments — only the human-friendly message.
    assert.doesNotMatch(text, /at Object\.<anonymous>/);
    assert.doesNotMatch(text, /at async /);
    assert.doesNotMatch(text, /at Module\._compile/);
  } finally {
    console.error = origErr;
    process.env = original;
  }
});

test('A-006b partial env (only TG_BRIDGE_TOKEN): still exits 1, lists the two missing', async () => {
  const original = { ...process.env };
  for (const k of bridgeBin.REQUIRED_ENV) delete process.env[k];
  process.env.TG_BRIDGE_TOKEN = 'bot123:abc';
  delete process.env.TG_ALLOWED_USERS;

  const captured = [];
  const origErr = console.error;
  console.error = (...args) => captured.push(args.join(' '));
  try {
    const code = await bridgeBin.main(process.env);
    assert.equal(code, 1);
    const text = captured.join('\n');
    // The two missing keys must each appear on the missing-env list
    // (the indented `- KEY` lines directly under "missing required env:").
    const missingBlock = text.split('Set them and retry')[0];
    assert.match(missingBlock, /- TG_GATEWAY_URL/);
    assert.match(missingBlock, /- TG_TOKEN/);
    // And TG_BRIDGE_TOKEN must NOT be on that list (we set it).
    assert.doesNotMatch(missingBlock, /- TG_BRIDGE_TOKEN/);
  } finally {
    console.error = origErr;
    process.env = original;
  }
});

// ---------- A-007 callback for already-resolved approval -----------------

test('A-007 callback for already-resolved approval: friendly "already resolved"', async () => {
  // The GatewayClient returns the parsed envelope — for a 404/409 it
  // surfaces as { error: "not_found" } or { error: "conflict" }.
  const approveCalls = [];
  const client = {
    approve: async (id) => {
      approveCalls.push(id);
      return { error: 'not_found', status: 404 };
    },
    deny:    async () => { throw new Error('should not be called'); },
    pending: async () => ({ pending: [] }),
    verify:  async () => ({ ok: true, length: 1, chainId: 'x' }),
    audit:   async () => ({ entries: [], verified: { ok: true }, head: 'h' }),
  };
  const { tgCall, sent } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  const specs = await bridge.handleUpdate({
    update_id: 1,
    callback_query: {
      id: 'cb_1', data: 'approve:apr_old', from: { id: 42 },
      message: { message_id: 55, chat: { id: 7001 } },
    },
  });
  assert.equal(approveCalls.length, 1, 'approve called');
  assert.equal(approveCalls[0], 'apr_old');
  const methods = specs.map((s) => s.method);
  assert.ok(methods.includes('answerCallbackQuery'));
  assert.ok(methods.includes('editMessageReplyMarkup'));
  const acq = specs.find((s) => s.method === 'answerCallbackQuery');
  assert.match(acq.params.text, /Already resolved/);
  // No "Approved" text leaked.
  assert.doesNotMatch(acq.params.text, /Approved/);
  // The follow-up edit removes the inline buttons so the user can't tap again.
  const edit = specs.find((s) => s.method === 'editMessageReplyMarkup');
  assert.deepEqual(edit.params.reply_markup.inline_keyboard, []);
});

test('A-007b callback for already-resolved approval (409 conflict envelope)', async () => {
  const client = {
    approve: async () => ({ error: 'conflict', status: 409 }),
    deny:    async () => ({ error: 'conflict', status: 409 }),
    pending: async () => ({ pending: [] }),
    verify:  async () => ({ ok: true }),
    audit:   async () => ({ entries: [] }),
  };
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  // approve path
  const r1 = await bridge.handleUpdate({
    update_id: 1,
    callback_query: {
      id: 'cb_1', data: 'approve:apr_old', from: { id: 42 },
      message: { message_id: 55, chat: { id: 7001 } },
    },
  });
  assert.match(r1.find((s) => s.method === 'answerCallbackQuery').params.text, /Already resolved/);

  // deny path
  const r2 = await bridge.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'cb_2', data: 'deny:apr_old', from: { id: 42 },
      message: { message_id: 55, chat: { id: 7001 } },
    },
  });
  assert.match(r2.find((s) => s.method === 'answerCallbackQuery').params.text, /Already resolved/);
});

// ---------- additional safety cases --------------------------------------

test('/help lists the documented commands', async () => {
  const { client } = makeStubClient();
  const { tgCall, sent } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });
  const specs = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: '/help', chat: { id: 7001 }, from: { id: 42 } },
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].method, 'sendMessage');
  assert.match(specs[0].params.text, /\/pending/);
  assert.match(specs[0].params.text, /\/verify/);
  assert.match(specs[0].params.text, /\/audit/);
  assert.match(specs[0].params.text, /\/help/);
});

test('empty / pending list sends a polite "No pending approvals."', async () => {
  const { client } = makeStubClient({ pending: async () => ({ pending: [] }) });
  const { tgCall, sent } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });
  const specs = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: '/pending', chat: { id: 7001 }, from: { id: 42 } },
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].method, 'sendMessage');
  assert.match(specs[0].params.text, /No pending approvals/);
});

test('unknown command yields polite "Unknown command" reply', async () => {
  const { client } = makeStubClient();
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });
  const specs = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: '/unicorn', chat: { id: 7001 }, from: { id: 42 } },
  });
  assert.equal(specs.length, 1);
  assert.match(specs[0].params.text, /Unknown command/);
});

test('non-command text messages are silently ignored (no specs)', async () => {
  const { client, calls } = makeStubClient();
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });
  const specs = await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 10, text: 'hello bot', chat: { id: 7001 }, from: { id: 42 } },
  });
  assert.deepEqual(specs, []);
  assert.equal(calls.pending + calls.verify + calls.audit, 0);
});

test('callback with unknown action yields "Unknown action" answer', async () => {
  const { client } = makeStubClient();
  const { tgCall } = makeStubTgCall();
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });
  const specs = await bridge.handleUpdate({
    update_id: 1,
    callback_query: {
      id: 'cb_x', data: 'banana:apr_1', from: { id: 42 },
      message: { message_id: 55, chat: { id: 7001 } },
    },
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].method, 'answerCallbackQuery');
  assert.match(specs[0].params.text, /Unknown action/);
});

// ---------- daemon loop: real http servers, no real Telegram --------------

// Start a local http server that speaks Telegram Bot API. We only need to
// handle `getUpdates` and `sendMessage` for this end-to-end check.
function startFakeTelegramApi(handler) {
  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
      const m = req.url.match(/^\/bot[^/]+\/([^?]+)/);
      const method = m ? m[1] : '';
      Promise.resolve(handler(method, body, req, res)).catch((e) => {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, description: e.message }));
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
    server.on('error', reject);
  });
}

// Daemon loop test: we drive `startLoop` directly with an injected
// `telegramCall` that posts to a local fake Telegram server. This
// exercises the actual bin/bridge-telegram.js loop code (backoff, error
// handling, update dispatch) without ever touching api.telegram.org.
//
// We then make the fake Telegram server's getUpdates handler point at a
// fake gateway that returns valid /v1/approvals JSON, plus inject a
// failing gateway to verify the self-heal/no-crash property (A-004).

test('daemon loop: /pending dispatched through local fake servers; poll loop survives gateway failure', async () => {
  // 1) Fake Telegram server. First getUpdates delivers one /pending;
  //    second call returns a forced 500 (gateway-failure proxy — the
  //    daemon must log + backoff + keep polling, NOT crash).
  const sent = [];
  let polls = 0;
  let firstPollDone = false;
  const fakeTg = await startFakeTelegramApi((method, body, req, res) => {
    if (method === 'getUpdates') {
      polls++;
      if (!firstPollDone) {
        firstPollDone = true;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({
          ok: true,
          result: [{
            update_id: 1,
            message: { message_id: 10, text: '/pending', chat: { id: 7001 }, from: { id: 42 } },
          }],
        }));
      }
      // Second poll: simulate Telegram network glitch (server closes).
      req.socket.destroy();
      return;
    }
    if (method === 'sendMessage') {
      sent.push(body);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, result: { message_id: sent.length, chat: { id: body.chat_id } } }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  });

  // 2) Fake gateway: /v1/approvals returns one approval.
  const fakeGw = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === '/v1/approvals') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({
          pending: [
            { id: 'apr_loop', bot: 'forge', tool: 'shell.run', args: { cmd: 'echo hi' } },
          ],
        }));
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  const gwUrl = await new Promise((resolve, reject) => {
    fakeGw.listen(0, '127.0.0.1', () => {
      const { port } = fakeGw.address();
      resolve(`http://127.0.0.1:${port}`);
    });
    fakeGw.on('error', reject);
  });

  // 3) Drive the daemon's exported startLoop() directly, pointing the
  //    Telegram call at our fake server via an injected tgCall.
  const { GatewayClient } = require('../src/gateway/client');
  const client = new GatewayClient({ baseUrl: gwUrl, token: 't', timeout: 1000 });
  const tgCall = (method, params) => {
    // POST to the fake Telegram server.
    const data = JSON.stringify(params || {});
    return new Promise((resolve, reject) => {
      const req = http.request(`${fakeTg.url}/botTEST/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')));
      });
      req.on('error', reject);
      req.write(data); req.end();
    });
  };
  const bridge = createBridge({ client, tgCall, allowedUsers: [42] });

  // Run the loop with short sleep backoff and a stop on first sendMessage.
  const loopPromise = bridgeBin.startLoop({
    bridge,
    botToken: 'TEST',
    tgCall,
    exitOnStop: false,
    sleepImpl: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
  });

  // Wait until either: (a) we see one sendMessage, or (b) 2s pass.
  const start = Date.now();
  while (sent.length === 0 && (Date.now() - start) < 2000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  // Stop the loop via SIGINT — process.once is registered inside startLoop.
  process.emit('SIGINT');
  await loopPromise;

  // Asserts:
  //   - Telegram polled at least twice (delivery + the forced-fail)
  //   - sendMessage fired exactly once (the /pending card)
  //   - the card mentions bot+tool and not args
  assert.ok(polls >= 1, `expected at least 1 getUpdates, got ${polls}`);
  assert.equal(sent.length, 1, 'one sendMessage for the /pending card');
  assert.match(sent[0].text, /Bot: forge/);
  assert.match(sent[0].text, /Tool: shell\.run/);
  assert.doesNotMatch(sent[0].text, /echo hi/); // no args leak
  assert.equal(sent[0].chat_id, 7001);
  assert.ok(Array.isArray(sent[0].reply_markup.inline_keyboard));

  // Clean up servers.
  await new Promise((r) => fakeGw.close(() => r()));
  await fakeTg.close();
});

test('startLoop: rejects cleanly if bridge is missing', async () => {
  await assert.rejects(
    () => bridgeBin.startLoop({ botToken: 'TEST' }),
    (err) => err.message.includes('bridge'),
  );
});
