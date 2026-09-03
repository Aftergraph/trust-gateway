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

module.exports = {
  name: 'v2-impact',
  method: 'GET',
  path: /^\/v2\/approvals\/([^/]+)\/impact$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const [, id] = ctx.params.matches;
    const approval = gw.approvals.get(id);
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