'use strict';
// FS-A2: identity-aware access — botGrants helpers.
//
// botGrants shape: `[{ bot: string, role: string }]` — one entry per bot the
// user may use through the identity-aware API (mounts/102-identity.js and
// mounts/103-chat-user.js).
//
// CONTRACT WITH FS-A1 (users.js / sessions.js / 101-auth.js, built in a
// separate slice): the UserStore persists the botGrants array VERBATIM on the
// user record — no transformation, no expansion, no server-side merge with
// bot capabilities. Whatever array `grant()`/`revoke()` returns here is
// exactly what lands in the user record and what UserStore.get() hands back
// (and what `gw._currentUser(req)` exposes as `user.botGrants`). These
// helpers are the only sanctioned way to produce that array.
//
// Zero dependencies (repo rule): plain JS data transforms only.

// Key filter for identity projections: any field whose name even looks like
// secret material is dropped from API responses. We never project hashes,
// tokens, salts or credentials — same STRICT rule as /v2/whoami and /v2/bots.
const SENSITIVE_RE = /pass|hash|secret|token|credential|salt|api_?key/i;

const DEFAULT_ROLE = 'worker';

// Coerce arbitrary input into the canonical [{bot, role}] shape.
// - drops malformed entries (non-object, empty/non-string bot)
// - defaults role to 'worker'
// - dedupes by bot (last entry wins)
function normalizeGrants(grants) {
  const out = [];
  const byBot = new Map();
  for (const g of Array.isArray(grants) ? grants : []) {
    if (!g || typeof g.bot !== 'string' || g.bot.length < 1) continue;
    const entry = { bot: g.bot, role: typeof g.role === 'string' && g.role ? g.role : DEFAULT_ROLE };
    if (byBot.has(entry.bot)) out[byBot.get(entry.bot)] = entry;
    else { byBot.set(entry.bot, out.length); out.push(entry); }
  }
  return out;
}

// Add (or update) a grant. Pure: returns a NEW array; the input is untouched.
// Throws on an invalid bot name so a caller cannot silently persist junk
// into the user record.
function grant(grants, bot, role = DEFAULT_ROLE) {
  if (typeof bot !== 'string' || bot.length < 1) throw new TypeError('grant: bot must be a non-empty string');
  if (typeof role !== 'string' || role.length < 1) throw new TypeError('grant: role must be a non-empty string');
  const next = normalizeGrants(grants).filter((g) => g.bot !== bot);
  next.push({ bot, role });
  return next;
}

// Remove a grant. Pure: returns a NEW array; revoking an unknown bot is a
// no-op (same array content, still a fresh array).
function revoke(grants, bot) {
  if (typeof bot !== 'string') throw new TypeError('revoke: bot must be a string');
  return normalizeGrants(grants).filter((g) => g.bot !== bot);
}

// May `user` use `bot`? True iff the user record carries a grant entry for
// that exact bot name. Safe on any malformed input (never throws).
function canUse(user, bot) {
  if (!user || typeof bot !== 'string') return false;
  if (!Array.isArray(user.botGrants)) return false;
  return user.botGrants.some((g) => g && g.bot === bot);
}

// First granted bot (insertion order) — used as the default acting bot when
// a user-bound chat request does not name one.
function firstGrantedBot(user) {
  if (!user || !Array.isArray(user.botGrants)) return null;
  const g = user.botGrants.find((x) => x && typeof x.bot === 'string' && x.bot);
  return g ? g.bot : null;
}

// Capabilities implied by the grants: the union of the granted bots'
// capability lists as configured on THIS gateway. Bots that do not exist
// on the gateway contribute nothing (no capabilities are invented here).
function capabilitiesForGrants(grants, gw) {
  const out = [];
  const seen = new Set();
  const bots = (gw && gw.bots) || {};
  for (const g of normalizeGrants(grants)) {
    const b = bots[g.bot];
    const caps = Array.isArray(b && b.capabilities) ? b.capabilities : [];
    for (const c of caps) {
      if (typeof c === 'string' && !seen.has(c)) { seen.add(c); out.push(c); }
    }
  }
  return out;
}

// Identity projection for GET /v2/me: the user record minus password/secret
// material, plus botGrants verbatim plus the capabilities those grants imply.
function projectUser(user, gw) {
  const out = {};
  for (const [k, v] of Object.entries(user || {})) {
    if (SENSITIVE_RE.test(k)) continue;
    out[k] = v;
  }
  out.botGrants = normalizeGrants(out.botGrants);
  out.capabilities = capabilitiesForGrants(out.botGrants, gw);
  return out;
}

module.exports = {
  SENSITIVE_RE,
  DEFAULT_ROLE,
  normalizeGrants,
  grant,
  revoke,
  canUse,
  firstGrantedBot,
  capabilitiesForGrants,
  projectUser,
};
