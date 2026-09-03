'use strict';
// v2 mount: Impact analysis snapshot for an approval.
//
//   GET /v2/approvals/:id/impact  (bearer) → { snapshot, evidenceChainRefs }
//
// Returns the stored impact snapshot from the Approval record plus
// the live chain entries that reference this approval. The snapshot
// never includes raw args (audit hygiene: approval_impact_snapshot
// only carries {approvalId, risk, confidence}).

const { send, readBody } = require('../server');
const { resolveTenant } = require('../tenant-resolve');
const { enforceQuotas } = require('../tenant-scope');
const { approvalsStoreFor } = require('./09-approvals');

module.exports = {
  name: 'v2-impact',
  method: 'GET',
  path: /^\/v2\/approvals\/([^/]+)\/impact$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    // FS-E1d: tenant scope — the impact surface reads the SAME per-tenant
    // approvals store the /v1 routes park into. Main keeps gw.approvals
    // (byte-identical); non-main tenants get their scoped store. Unknown/
    // disabled tenant → 404 (anti-enumeration).
    req.bot = ctx.bot;
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return send(res, 404, { error: 'not_found' });
    if (enforceQuotas(gw, tenant, res)) return; // FS-I3: fail-closed quotas
    const [, id] = ctx.params.matches;
    const store = approvalsStoreFor(gw, tenant);
    const approval = store.get(id);
    if (!approval) {
      return send(res, 404, { error: 'not_found' });
    }

    // Stored snapshot from the Approval record — never includes raw args.
    const snapshot = approval.impact || null;

    // Live chain refs: entries whose payload references this approval id.
    const evidenceChainRefs = [];
    if (gw.chain && Array.isArray(gw.chain.entries)) {
      for (const entry of gw.chain.entries) {
        const p = entry.payload || {};
        if (p.approvalId === id) {
          evidenceChainRefs.push(entry.seq);
        }
      }
    }

    return send(res, 200, { snapshot, evidenceChainRefs });
  },
};