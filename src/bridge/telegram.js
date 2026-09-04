'use strict';
// Trust Gateway — Telegram bridge (Slice 4).
//
// Thin Telegram <-> GatewayClient shim. ZERO governance logic lives here:
// every action runs through `client` (a GatewayClient instance). The bridge
// only formats Telegram messages and parses user commands.
//
// Public surface (testable):
//   createBridge({ client, tgCall, allowedUsers, log })
//     -> { handleUpdate(update), handleCommand(text, ctx), helpText }
//
//   handleUpdate: dispatches one Telegram Update (message or callback_query)
//   handleCommand: parses a command string, runs it, returns an array of
//                  tgCall-shaped instructions the caller (poll loop) sends.
//                  Keeping handlers pure lets us test without a network.
//
//   tgCall(method, params) -> Promise<unknown>
//     Injectable: production uses a node:https POST against
//     `https://api.telegram.org/bot<TOKEN>/<method>`; tests pass a stub.

const DEFAULT_LONG_POLL_TIMEOUT = 25; // seconds — Telegram-side timeout

/**
 * Parse a numeric Telegram user ID allowlist from a CSV env string.
 * Empty / missing => empty Set (deny-all, fail closed).
 */
function parseAllowedUsers(raw) {
  const out = new Set();
  if (!raw) return out;
  for (const piece of String(raw).split(',')) {
    const n = Number(piece.trim());
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
}

/**
 * Sanitize a free-form "tool" string so we never echo a path/arg that
 * an upstream producer accidentally stuffed into the tool field. We keep
 * the leading namespace (everything before the first `:`) which is what
 * legitimate tool names look like (`fs.write`, `shell.run`). Anything
 * after the colon is treated as data and dropped.
 */
function sanitizeTool(t) {
  const s = String(t || 'unknown-tool');
  const i = s.indexOf(':');
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Format a single pending approval as a card. NEVER include args/secret
 * values — only `bot` (the requesting bot) and `tool` (action.tool,
 * sanitized to the leading namespace).
 *
 * Returns { text, reply_markup }.
 */
function formatApprovalCard(p) {
  // Defensive: if upstream accidentally leaks args/secrets via p.tool
  // (e.g. "fs.write:/etc/passwd"), strip the data half.
  const bot = String(p.bot || p.botName || 'unknown-bot');
  const tool = sanitizeTool(p.tool || p.action?.tool);
  const id = String(p.id || p.approvalId || '');
  const text = `Pending approval\nBot: ${bot}\nTool: ${tool}\nID: ${id}`;
  const reply_markup = {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `approve:${id}` },
      { text: 'Deny',    callback_data: `deny:${id}` },
    ]],
  };
  return { text, reply_markup };
}

/**
 * Build a friendly summary of one audit entry. Returns only type/bot/tool
 * — never args / payloads / secrets.
 */
function summarizeAuditEntry(e) {
  const seq = e.seq != null ? `#${e.seq} ` : '';
  const type = e.type || e.action?.type || 'event';
  const bot = e.bot || e.actor || 'system';
  const tool = e.tool || e.action?.tool || '';
  return `${seq}${type} bot=${bot}${tool ? ` tool=${tool}` : ''}`;
}

/**
 * Coerce any thrown / returned error from `client` into a user-facing
 * message + a flag. Self-heal: callers MUST keep polling regardless.
 */
function friendlyGatewayError(err) {
  const msg = (err && err.message) || String(err);
  // Network / unreachable — tell the user clearly.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|request timed out|socket hang up/i.test(msg)) {
    return 'Gateway unreachable — try again shortly.';
  }
  if (/invalid JSON/i.test(msg)) {
    return 'Gateway returned an invalid response.';
  }
  return `Gateway error: ${msg}`;
}

/**
 * Map a 404/409-style client error (HTTP envelope {error, decision})
 * into an "already resolved" friendly message. Used by A-007.
 */
function isAlreadyResolved(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.error === 'not_found' || result.status === 404) return true;
  if (result.error === 'conflict' || result.status === 409) return true;
  return false;
}

/**
 * createBridge — pure handler factory.
 *
 * @param {object} opts
 * @param {{pending:Function, approve:Function, deny:Function, verify:Function, audit:Function}} opts.client
 *        Any object with the GatewayClient methods we need.
 * @param {(method:string, params:object)=>Promise<unknown>} opts.tgCall
 *        Telegram Bot API call shim. Production wraps node:https; tests
 *        pass a stub that records calls.
 * @param {Set<number>|number[]} [opts.allowedUsers=[]]
 *        Telegram user IDs permitted to talk to the bridge. Empty =>
 *        deny-all (fail closed).
 * @param {{info:Function, warn:Function, error:Function}} [opts.log]
 *        Optional logger; defaults to console.
 */
function createBridge({ client, tgCall, allowedUsers = [], log } = {}) {
  if (!client || typeof client.pending !== 'function') {
    throw new Error('createBridge: client with .pending()/.approve()/.deny()/.verify()/.audit() required');
  }
  if (typeof tgCall !== 'function') {
    throw new Error('createBridge: tgCall(method, params) function required');
  }
  const allow = allowedUsers instanceof Set ? allowedUsers : new Set(allowedUsers || []);
  const logger = log || {
    info:  (...a) => console.log('[bridge]', ...a),
    warn:  (...a) => console.warn('[bridge]', ...a),
    error: (...a) => console.error('[bridge]', ...a),
  };

  const HELP_TEXT = [
    'Trust Gateway bridge commands:',
    '/pending  — list approvals waiting for human review',
    '/verify   — audit chain integrity check',
    '/audit [N] — last N audit entries (default 5, type/bot/tool only)',
    '/help     — this message',
  ].join('\n');

  /**
   * Handle a text command. `ctx` is { chatId, fromId }. Returns an array
   * of tgCall specs the caller should issue. On silent-ignore (unknown
   * user) returns an empty array and logs.
   */
  async function handleCommand(text, ctx) {
    const { chatId, fromId } = ctx || {};
    if (!allow.has(Number(fromId))) {
      logger.warn('ignored message from non-allowed user', { fromId, chatId });
      return [];
    }
    const raw = String(text || '').trim();
    if (!raw.startsWith('/')) return [];

    // Strip optional @botname suffix from command (Telegram groups).
    const [head, ...rest] = raw.split(/\s+/);
    const cmd = head.split('@')[0].toLowerCase();

    try {
      if (cmd === '/help') {
        return [{ method: 'sendMessage', params: { chat_id: chatId, text: HELP_TEXT } }];
      }
      if (cmd === '/pending') {
        const r = await client.pending();
        const list = Array.isArray(r?.pending) ? r.pending : [];
        if (list.length === 0) {
          return [{ method: 'sendMessage', params: { chat_id: chatId, text: 'No pending approvals.' } }];
        }
        const cards = list.map(formatApprovalCard).map((c) => ({
          method: 'sendMessage',
          params: { chat_id: chatId, text: c.text, reply_markup: c.reply_markup },
        }));
        return cards;
      }
      if (cmd === '/verify') {
        const v = await client.verify();
        const ok = !!v?.ok;
        const length = Number(v?.length ?? 0);
        const chainId = v?.chainId || v?.chain_id || 'unknown';
        const text = `verify: ok=${ok} length=${length} chainId=${chainId}`;
        return [{ method: 'sendMessage', params: { chat_id: chatId, text } }];
      }
      if (cmd === '/audit') {
        const limit = Math.max(1, Math.min(50, Number(rest[0]) || 5));
        // Read everything then summarize the tail (caller's contract is
        // "last N entries"; with a 50k chain a since=N slice is plenty).
        const all = await client.audit(0);
        const entries = Array.isArray(all?.entries) ? all.entries : [];
        const tail = entries.slice(-limit);
        if (tail.length === 0) {
          return [{ method: 'sendMessage', params: { chat_id: chatId, text: 'No audit entries.' } }];
        }
        const lines = tail.map(summarizeAuditEntry);
        const text = `Last ${tail.length} audit entries:\n` + lines.join('\n');
        return [{ method: 'sendMessage', params: { chat_id: chatId, text } }];
      }
      // Unknown command — be quiet, list help.
      return [{ method: 'sendMessage', params: { chat_id: chatId, text: 'Unknown command. Try /help.' } }];
    } catch (err) {
      logger.error('command failed', { cmd, err: err && err.message });
      return [{ method: 'sendMessage', params: { chat_id: chatId, text: friendlyGatewayError(err) } }];
    }
  }

  /**
   * Handle an approve/deny callback_query. `cb` is the callback_query
   * object (must include .id, .data, .message.chat.id, .from.id).
   * Returns an array of tgCall specs.
   */
  async function handleCallback(cb) {
    if (!cb || typeof cb.data !== 'string') return [];
    const fromId = cb.from && cb.from.id;
    if (!allow.has(Number(fromId))) {
      logger.warn('ignored callback from non-allowed user', { fromId });
      return [{ method: 'answerCallbackQuery', params: { callback_query_id: cb.id, text: 'Not authorized.' } }];
    }
    const [action, ...rest] = cb.data.split(':');
    const id = rest.join(':'); // IDs never contain ':' but be defensive
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;

    try {
      let result;
      if (action === 'approve') result = await client.approve(id);
      else if (action === 'deny') result = await client.deny(id);
      else {
        return [{ method: 'answerCallbackQuery', params: { callback_query_id: cb.id, text: 'Unknown action.' } }];
      }

      // Map already-resolved (404/409) to a friendly message — A-007.
      if (isAlreadyResolved(result)) {
        return [
          { method: 'answerCallbackQuery', params: { callback_query_id: cb.id, text: 'Already resolved.', show_alert: false } },
          { method: 'editMessageReplyMarkup', params: { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } } },
        ];
      }

      // Map a real error to a friendly notice but still answer the callback.
      if (result && (result.error || result.status >= 400)) {
        const notice = friendlyGatewayError(new Error(result.error || `status ${result.status}`));
        return [
          { method: 'answerCallbackQuery', params: { callback_query_id: cb.id, text: notice, show_alert: false } },
          { method: 'editMessageReplyMarkup', params: { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } } },
        ];
      }

      // Success — edit markup off the card and answer.
      const newText = result?.status === 'approved'
        ? '✅ Approved.'
        : result?.status === 'denied'
        ? '❌ Denied.'
        : 'Done.';
      return [
        { method: 'answerCallbackQuery', params: { callback_query_id: cb.id, text: newText, show_alert: false } },
        { method: 'editMessageText', params: { chat_id: chatId, message_id: messageId, text: newText, reply_markup: { inline_keyboard: [] } } },
      ];
    } catch (err) {
      logger.error('callback failed', { action, id, err: err && err.message });
      const notice = friendlyGatewayError(err);
      return [
        { method: 'answerCallbackQuery', params: { callback_query_id: cb.id, text: notice, show_alert: false } },
        { method: 'editMessageReplyMarkup', params: { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } } },
      ];
    }
  }

  /**
   * handleUpdate: dispatch one Telegram Update to the right handler.
   * Pure: returns an array of tgCall specs. Caller (poll loop) issues
   * them. Never throws.
   */
  async function handleUpdate(update) {
    if (!update || typeof update !== 'object') return [];
    try {
      if (update.message && typeof update.message.text === 'string') {
        const ctx = {
          chatId: update.message.chat?.id,
          fromId: update.message.from?.id,
        };
        return await handleCommand(update.message.text, ctx);
      }
      if (update.callback_query) {
        return await handleCallback(update.callback_query);
      }
      return [];
    } catch (err) {
      logger.error('handleUpdate crashed', { err: err && err.message });
      return [];
    }
  }

  return {
    handleUpdate,
    handleCommand,
    handleCallback,
    parseAllowedUsers,
    formatApprovalCard,
    summarizeAuditEntry,
    friendlyGatewayError,
    helpText: HELP_TEXT,
    DEFAULT_LONG_POLL_TIMEOUT,
  };
}

module.exports = {
  createBridge,
  parseAllowedUsers,
  formatApprovalCard,
  summarizeAuditEntry,
  friendlyGatewayError,
  isAlreadyResolved,
  DEFAULT_LONG_POLL_TIMEOUT,
};