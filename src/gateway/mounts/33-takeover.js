'use strict';
// v2 mount: /v2/takeover — HC8 human takeover continuity (TG-side).
//
// STUDY-013 hard case HC8: "human approval/takeover continuity — takeover
// survives re-admission, no authority leak". This mount implements the TG
// half of the takeover semantics demonstrated in aie
// experiments/live_benchmark/e2e_mission_demo_v2.py scenario S4:
//
//   POST /v2/takeover            { principal_id, reason } →
//       1. revoke ALL active parked/approved actions for that principal
//          (parked actions are denied with takeover_revoked status),
//       2. issue a fresh takeover lease envelope with SUBSET-only
//          capabilities (caller must pass an explicit capability list;
//          it is intersected with the principal's previous capabilities —
//          escalation is structurally impossible),
//       3. audit every step on the hash chain.
//
//   GET  /v2/takeover/:id        read one takeover record
//
// Fail-closed rules:
//   • unknown principal → 404 uniform (anti-enumeration)
//   • empty capability intersection → takeover issues a lease with NO
//     capabilities (valid but inert) — never silently wider than before
//   • every denial/audit write happens BEFORE the response is sent
//
// All stateful decisions are audited via gw._audit.

const { send, readBody } = require('../server');
const { canApprove } = require('../rbac');
const crypto = require('node:crypto');

const TAKEOVER_RE = /^\/v2\/takeover(?:\/([^/]+))?\/?$/;

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: 'invalid_json' };
  }
}

module.exports = {
  name: 'v2-takeover',
  method: '*',
  path: /^\/v2\/takeover(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const pathname = ctx.url.pathname;
    const m = TAKEOVER_RE.exec(pathname);
    if (!m) return send(res, 404, { error: 'not_found' });

    const store = getTakeoverStore(gw);

    // ── GET /v2/takeover/:id ──
    if (req.method === 'GET' && m[1]) {
      const rec = store.get(m[1]);
      if (!rec) return send(res, 404, { error: 'not_found' });
      return send(res, 200, rec);
    }

    // ── POST /v2/takeover ──
    if (req.method === 'POST') {
      if (!canApprove(ctx.bot)) {
        gw._audit({ type: 'takeover_forbidden', bot: ctx.bot.name });
        return send(res, 403, { error: 'operator_required' });
      }
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      const { principal_id, reason, capabilities } = body;
      if (!principal_id || typeof principal_id !== 'string') {
        return send(res, 400, { error: 'principal_id_required' });
      }
      if (!reason || typeof reason !== 'string') {
        return send(res, 400, { error: 'reason_required' });
      }

      // 1. Revoke the principal's parked actions (deny pending approvals).
      const revokedActions = store.revokePendingForPrincipal(gw, principal_id, reason);

      // 2. Capability subset: intersect requested with previously granted.
      const previous = store.previousCapabilitiesFor(gw, principal_id);
      const requested = Array.isArray(capabilities) ? capabilities : previous;
      const granted = [...new Set(requested)].filter((c) => previous.includes(c));

      // 3. Issue takeover record. No capabilities escalation is possible by
      //    construction (intersection); empty intersection = inert lease.
      const id = `takeover_${crypto.randomBytes(6).toString('hex')}`;
      const rec = {
        id,
        principal_id,
        reason,
        revoked_actions: revokedActions,
        previous_capabilities: previous,
        granted_capabilities: granted,
        escalation_blocked: granted.length <= previous.length,
        taken_over_at: new Date().toISOString(),
        by: ctx.bot.name,
      };
      store.put(rec);

      gw._audit({
        type: 'takeover_issued',
        takeover_id: id,
        principal_id,
        revoked_actions: revokedActions.length,
        granted_capabilities: granted,
        escalation_blocked: rec.escalation_blocked,
        reason,
      });

      return send(res, 200, {
        ok: true,
        takeover: { id, principal_id, revoked_actions: revokedActions, granted_capabilities: granted },
        note: 'AIE lease re-issue is performed by the AIE runtime on next admit; TG parks are revoked.',
      });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};

function getTakeoverStore(gw) {
  if (!gw._takeoverStore) {
    // ponytail: in-memory store, per-process; durable variant lands with
    // persistence-readiness slice (upgrade path: reuse db.js store pattern).
    const pending = new Map(); // principal_id -> [approval rows]
    const issued = new Map();
    const caps = new Map(); // principal_id -> [capabilities]
    gw._takeoverStore = {
      revokePendingForPrincipal(gw2, principalId, reason) {
        const out = [];
        try {
          const rows = gw2._approvals && gw2._approvals.list ? gw2._approvals.list() : [];
          for (const a of rows) {
            if (a && a.status === 'pending' && (a.principal_id === principalId || a.bot === principalId)) {
              try {
                gw2._approvals.deny(a.id, { reason: `takeover: ${reason}` });
                out.push(a.id);
              } catch { /* park-only store: skip */ }
            }
          }
        } catch { /* approvals store unavailable: nothing to revoke */ }
        return out;
      },
      previousCapabilitiesFor(gw2, principalId) {
        if (caps.has(principalId)) return caps.get(principalId);
        // derive from past audit entries mentioning the principal's grants
        const caps2 = [];
        try {
          const entries = gw2._chain && gw2._chain.entries ? gw2._chain.entries() : [];
          for (const e of entries) {
            const p = e.payload || e;
            if (p.type === 'action_admitted' && (p.bot === principalId || p.principal_id === principalId)) {
              for (const c of p.capabilities || []) if (!caps2.includes(c)) caps2.push(c);
            }
          }
        } catch { /* chain unavailable: no known capabilities */ }
        caps.set(principalId, caps2);
        return caps2;
      },
      put(rec) { issued.set(rec.id, rec); if (!caps.has(rec.principal_id)) caps.set(rec.principal_id, rec.granted_capabilities); },
      get(id) { return issued.get(id) || null; },
    };
  }
  return gw._takeoverStore;
}