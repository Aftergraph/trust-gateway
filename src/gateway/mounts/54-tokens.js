'use strict';
// v2 mount: POST /v2/tokens/rotate — operator-or-self token rotation.
//
// One mount file, method 'POST', RegExp path. Auth is bearer; the mount
// runner has already authenticated the caller, and THIS handler enforces
// the second gate (canSelfRotate): an operator (role==='operator' or
// approval.decide/* cap) may rotate ANY bot; a non-operator bot may
// rotate ONLY itself. Anything else → 403 + audit token_forbidden.
//
// Wire-format:
//   POST /v2/tokens/rotate     { bot: '<target-bot-name>' }
//   200 OK                     { bot: '<name>', token: '<new-plaintext-token>' }
//   400                        bad input
//   403                        not permitted (audit token_forbidden)
//   404                        unknown target bot
//
// Plaintext is returned ONCE in the response body and is the only place
// the secret is ever emitted (write-only secrets pattern, same shape as
// the W4 /v2/plugins/:id/secrets/:n PUT endpoint). It is never logged,
// never re-stored in gw.bots, and never appears in any audit entry.

const crypto = require('node:crypto');
const { send, readBody, hashToken, canSelfRotate } = require('../server');

const ROTATE_RE = /^\/v2\/tokens\/rotate\/?$/;

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

module.exports = {
  name: 'v2-tokens',
  method: 'POST',
  path: ROTATE_RE,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const body = await readJson(req);
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'invalid_json' });
    const target = typeof body.bot === 'string' ? body.bot.trim() : '';
    if (!target) return send(res, 400, { error: 'bot_required' });
    if (!Object.prototype.hasOwnProperty.call(gw.bots, target)) return send(res, 404, { error: 'unknown_bot' });

    // Authorization: operator/self-rotate gate. canSelfRotate returns true
    // for operators OR when the caller IS the target.
    if (!canSelfRotate(ctx.bot, target)) {
      gw._audit({ type: 'token_forbidden', bot: ctx.bot.name, target, path: ctx.url.pathname });
      return send(res, 403, { error: 'operator_or_self_required' });
    }

    // Generate 32 random bytes → 64 hex chars. crypto.randomBytes is the
    // platform CSPRNG; this is the only place a fresh secret is minted.
    const newToken = crypto.randomBytes(32).toString('hex');
    const newHash = hashToken(newToken);

    // Mark the OLD hash as stale (so subsequent requests with the old bearer
    // are audited as 'token_rejected_stale' — A-006). Do this BEFORE we
    // overwrite the slot, otherwise we'd lose the old digest.
    const oldHash = gw.bots[target] && gw.bots[target].tokenHash;
    if (oldHash && oldHash !== newHash) gw._markStale(target, oldHash);

    // Replace the bot's tokenHash in-place (single-request cycle — old
    // token fails immediately after this returns).
    gw.bots[target].tokenHash = newHash;
    delete gw.bots[target].token; // belt-and-suspenders: scrub any legacy plaintext field

    // Audit the rotation. NEVER include token values (plaintext or hash)
    // in the audit entry — only the bot name and operator/actor identity.
    gw._audit({ type: 'token_rotated', bot: target, by: ctx.bot.name });

    // Return the new plaintext to the caller ONCE. They are expected to
    // store it client-side and treat it as a write-only secret.
    return send(res, 200, { bot: target, token: newToken });
  },
};