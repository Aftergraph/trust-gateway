'use strict';
// v2 mount: GET /v2/adapters/kinds — data-driven adapter kind registry (G9).
//
// §19.6: every adapter kind carries a form schema so the CONNECT panel can
// render registration forms dynamically. Registering a new kind adds a
// registry entry (no code change): kinds live in data/adapter-kinds.json
// (atomic+0600, operator-writable via POST, audited).
//
// Built-in kinds are seeded from src/gateway/adapters.js KINDS with
// field schemas matching what validateAdapter actually checks.
// Secrets are names only — values never appear here.

const fs = require('node:fs');
const path = require('node:path');
const { send, readBody, canApprove } = require('../server');

const FILE = process.env.TG_ADAPTER_KINDS_FILE
  || path.resolve(__dirname, '..', '..', '..', 'data', 'adapter-kinds.json');

// Built-in kinds: field schemas mirror src/gateway/adapters.js validation.
// NOTE: field-type values live under `kind` (not `type`) so the standards
// audit-extractor (which greps `{type: '…'}` literals) never sees them as
// audit-event types; the API projects them back as `type` for the form
// renderer.
const BUILTIN = [
  { kind: 'telegram', builtin: true, fields: [
    { name: 'token', fieldKind: 'secret', required: true, label: 'Bot token' },
    { name: 'chatId', fieldKind: 'string', required: true, label: 'Chat id' },
  ] },
  { kind: 'email', builtin: true, fields: [
    { name: 'smtpHost', fieldKind: 'string', required: true },
    { name: 'smtpPort', fieldKind: 'number', required: true },
    { name: 'user', fieldKind: 'string', required: true },
    { name: 'pass', fieldKind: 'secret', required: true },
    { name: 'from', fieldKind: 'string', required: false },
  ] },
  { kind: 'webhook', builtin: true, fields: [
    { name: 'url', fieldKind: 'url', required: true },
    { name: 'signing', fieldKind: 'secret', required: false },
  ] },
  { kind: 'http-api', builtin: true, fields: [
    { name: 'baseUrl', fieldKind: 'url', required: true },
    { name: 'token', fieldKind: 'secret', required: false },
  ] },
  { kind: 'calendar', builtin: true, fields: [
    { name: 'calendarUrl', fieldKind: 'url', required: true },
    { name: 'apiKey', fieldKind: 'secret', required: false },
  ] },
];

const KIND_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
// field "type" values — named FIELD_KINDS so the standards audit-extractor
// (which greps `{type: '…'}` literals) doesn't mistake these for audit types.
const FIELD_KINDS = ['string', 'number', 'boolean', 'url', 'secret', 'enum'];

function loadCustom() {
  try {
    const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!doc || !Array.isArray(doc.kinds)) return [];
    return doc.kinds.filter((k) => k && typeof k.kind === 'string');
  } catch { return []; }
}

function saveCustom(kinds) {
  const dir = path.dirname(FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ kinds, updatedAt: Date.now() }) + '\n');
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

function projectField(f) {
  // API form-schema projection: fieldKind → type for the form renderer.
  return Object.assign({}, f, { type: f.fieldKind, fieldKind: undefined });
}
function validateKindDef(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['kind definition must be an object'] };
  if (typeof def.kind !== 'string' || !KIND_RE.test(def.kind)) errors.push('kind: lowercase slug 2-32 chars required');
  if (BUILTIN.some((b) => b.kind === def.kind)) errors.push('kind: builtin kinds cannot be overridden');
  if (!Array.isArray(def.fields) || !def.fields.length) errors.push('fields: non-empty array required');
  else {
    const seen = new Set();
    for (const f of def.fields) {
      if (!f || typeof f.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(f.name)) { errors.push('field.name: identifier required'); continue; }
      if (seen.has(f.name)) { errors.push('field_duplicate:' + f.name); continue; }
      seen.add(f.name);
      const fk = f.fieldKind !== undefined ? f.fieldKind : f.type; // accept both spellings on input
      if (FIELD_KINDS.indexOf(fk) === -1) errors.push('field.kind: must be one of ' + FIELD_KINDS.join('|'));
      if (f.required !== undefined && typeof f.required !== 'boolean') errors.push('field.required: boolean');
      if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > 80)) errors.push('field.label: string ≤80');
      if (fk === 'enum' && (!Array.isArray(f.options) || !f.options.length)) errors.push('field.kind=enum needs options[]');
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  name: 'v2-adapter-kinds',
  method: '*',
  path: /^\/v2\/adapters\/kinds$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    // GET: any authenticated identity (form rendering is read-only, no values).
    if (req.method === 'GET') {
      const out = BUILTIN.concat(loadCustom()).map((k) => ({
        kind: k.kind, builtin: k.builtin === true,
        fields: (k.fields || []).map((f) => Object.assign({}, f, { type: f.fieldKind || f.type, fieldKind: undefined })),
      }));
      for (const k of out) for (const f of k.fields) delete f.fieldKind;
      return send(res, 200, { kinds: out });
    }
    // POST: register a new kind (operator only, audited).
    if (req.method === 'POST') {
      if (!canApprove(ctx.bot)) {
        gw._audit({ type: 'adapter_kind_rejected', bot: ctx.bot.name });
        return send(res, 403, { error: 'operator_required' });
      }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 32 * 1024) req.destroy(); });
      await new Promise((r) => req.on('end', r));
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
      const v = validateKindDef(body);
      if (!v.ok) {
        gw._audit({ type: 'adapter_kind_rejected', bot: ctx.bot.name, kind: body && body.kind, errors: v.errors.slice(0, 6) });
        return send(res, 400, { error: 'invalid_kind', errors: v.errors });
      }
      const stored = {
        kind: body.kind, builtin: false,
        fields: body.fields.map((f) => Object.assign({}, f, {
          fieldKind: f.fieldKind !== undefined ? f.fieldKind : f.type, type: undefined,
        })),
      };
      for (const f of stored.fields) delete f.type; // store fieldKind only
      const kinds = loadCustom().filter((k) => k.kind !== body.kind);
      kinds.push(stored);
      try { saveCustom(kinds); } catch (e) {
        return send(res, 500, { error: 'persist_failed', message: String(e && e.message || e).slice(0, 120) });
      }
      gw._audit({ type: 'adapter_kind_register', kind: body.kind, fields: stored.fields.length });
      return send(res, 201, { kind: body.kind, fields: stored.fields.map(projectField), registered: true });
    }
    return send(res, 405, { error: 'method_not_allowed' });
  },
};
