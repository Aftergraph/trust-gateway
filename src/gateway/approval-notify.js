'use strict';
// D2 mount: approval-notify — Telegram-notify ved pending approvals.
//
// wire(gw) subscribes på gw._audit feeden og sender fire-and-forget Telegram-
// notifikation når en action parkeres som needs_approval. Fail-open: fejl
// swallowes og auditeres (approval_notify_failed) — approval-flowet brydes
// ALDRIG af notifications. Ingen secrets i teksten (kun bot + tool).
//
// Konfiguration:
//   TG_TELEGRAM_TOKEN — required for at sende (adapter-kontrakt)
//   TG_NOTIFY_CHAT_ID — required chat-id (uden den er wire() inert)
//
// Audit: approval_notify_sent {chat_id, chars} / approval_notify_failed {error}.

const { telegramAdapter } = require('./telegram-adapter');

module.exports = {
  name: 'approval-notify',

  // Wire: kaldes én gang af serveren (eller tests med en stub-gw). Returnerer
  // audit-handleren, så serveren kan tilslutte den til sin audit-feed.
  wire(gw) {
    const chatId = process.env.TG_NOTIFY_CHAT_ID || '';
    return (entry) => {
      if (!entry || entry.type !== 'action_decision' || entry.decision !== 'needs_approval') return;
      if (!chatId) return; // ingen modtager konfigureret → inert (fail-open)
      const text = `Approval pending: ${entry.bot} vil køre ${entry.tool}. Godkend i TG-konsollen.`;
      Promise.resolve()
        .then(() => {
          // adapter oprettes pr. kald — fetchImpl fanges frisk (test-stubs + proxy-swap)
          const adapter = telegramAdapter({ fetch: globalThis.fetch });
          return adapter.sendNotification({ chatId, text, token: process.env.TG_TELEGRAM_TOKEN });
        })
        .then((out) => {
          const ok = !!(out && out.ok);
          try {
            gw._audit(ok
              ? { type: 'approval_notify_sent', chat_id: String(chatId), chars: text.length, status: out.status }
              : { type: 'approval_notify_failed', error: (out && out.description) || ('status ' + (out && out.status)) });
          } catch { /* audit utilgængelig i stub-gw */ }
        })
        .catch((e) => {
          try {
            gw._audit({ type: 'approval_notify_failed', error: (e && e.message) || 'unknown' });
          } catch { /* fail-open */ }
        });
    };
  },
};