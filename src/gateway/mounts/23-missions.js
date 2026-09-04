'use strict';
// v2 mount: /v2/proposals — W0.2 MissionProposal + W0.3 mission correlation.
//
//   POST   /v2/proposals                 create proposal {proposer, objective, ...}
//   GET    /v2/proposals                 list (?status=submitted)
//   GET   /v2/proposals/:id              one proposal
//   POST   /v2/proposals/:id/submit      draft -> submitted
//   POST   /v2/proposals/:id/approve     {approver, mission_id?} -> stamped correlation
//   POST   /v2/proposals/:id/reject      {reason}
//
// RBAC: create/submit allowed for any authenticated bot (chat flow origin);
// approve/reject require canApprove (operator). Every stateful decision audited.

const { send, readBody } = require('../server');
const { canApprove } = require('../rbac');
const { MissionProposalStore } = require('../missions');
const crypto = require('node:crypto');

const RE = /^\/v2\/proposals(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/;

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: 'invalid_json' };
  }
}

module.exports = {
  name: 'v2-proposals',
  method: '*',
  path: /^\/v2\/proposals(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!gw._proposalStore) {
      gw._proposalStore = new MissionProposalStore();
    }
    const store = gw._proposalStore;
    const m = RE.exec(ctx.url.pathname);
    if (!m) return send(res, 404, { error: 'not_found' });
    const [, id, verb] = m;

    if (req.method === 'GET' && !id) {
      return send(res, 200, { proposals: store.list() });
    }
    if (req.method === 'GET' && id) {
      const p = store.get(id);
      if (!p) return send(res, 404, { error: 'not_found' });
      return send(res, 200, p);
    }
    if (req.method === 'POST' && !id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        const p = store.create({
          proposer: body.proposer || ctx.bot.name,
          channel: body.channel,
          objective: body.objective,
          context: body.context,
          proposed_mission: body.proposed_mission,
          reasoning: body.reasoning,
          alternatives: body.alternatives_considered,
          approval_requested: body.approval_requested,
          approvers: body.approvers,
          approval_deadline: body.approval_deadline,
        });
        gw._audit({ type: 'proposal_created', proposal_id: p.id, proposer: p.proposer, objective: p.objective });
        return send(res, 201, { ok: true, proposal: p });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (req.method === 'POST' && id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        if (verb === 'submit') {
          const p = store.submit(id);
          gw._audit({ type: 'proposal_submitted', proposal_id: id, proposer: p.proposer });
          return send(res, 200, { ok: true, proposal: p });
        }
        if (verb === 'approve') {
          if (!canApprove(ctx.bot)) {
            gw._audit({ type: 'proposal_approve_forbidden', proposal_id: id, bot: ctx.bot.name });
            return send(res, 403, { error: 'operator_required' });
          }
          const p = store.approve(id, ctx.bot.name, body.mission_id);
          gw._audit({
            type: 'proposal_approved',
            proposal_id: id,
            approver: ctx.bot.name,
            mission_id: p.converted_to_mission_id,
          });
          return send(res, 200, { ok: true, proposal: p });
        }
        if (verb === 'reject') {
          if (!canApprove(ctx.bot)) {
            gw._audit({ type: 'proposal_reject_forbidden', proposal_id: id, bot: ctx.bot.name });
            return send(res, 403, { error: 'operator_required' });
          }
          const p = store.reject(id, body.reason);
          gw._audit({ type: 'proposal_rejected', proposal_id: id, reason: p.rejection_reason });
          return send(res, 200, { ok: true, proposal: p });
        }
        return send(res, 404, { error: 'unknown_verb' });
      } catch (e) {
        return send(res, 409, { error: e.message });
      }
    }
    return send(res, 405, { error: 'method_not_allowed' });
  },
};