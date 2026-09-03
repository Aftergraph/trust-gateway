'use strict';
// FS-I7 mount — chain compaction / archival HTTP surface.
//
//   GET  /v2/chain/archive → list archive manifests (operator only)
//   POST /v2/chain/archive {beforeIso?} → trigger archival (operator only)
//
// SECURITY: operator-only (same isOperator gate as 110-backup). Refusals
// and denials are audited; success audits carry COUNTS and manifest keys
// only — never entry payloads, never file contents.
//
// GATING: POST is INERT unless TG_CHAIN_ARCHIVE=1 (module gate answers
// 501 archive_disabled); GET always works for operators (manifests may
// exist from earlier runs or a warm restore).

const { send, readBody } = require('../server');
const archive = require('../chain-archive');
// FS-G3: out-of-band alerting — module-level sink (server.js is untouched).
const { getAlertSink } = require('../alerting');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'chain-archive',
  method: '*',
  path: /^\/v2\/chain\/archive\/?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'chain_archive_refused', bot: ctx.bot && ctx.bot.name, reason: 'operator_required' });
      return send(res, 403, { error: 'operator_required' });
    }

    if (req.method === 'GET') {
      const { KV } = require('../kvstore');
      const kv = new KV({ db: gw.chain && gw.chain.db });
      const manifests = (kv.list('archive:chain:') || []).map((r) => ({
        key: r.key,
        ...(r.value || {}),
      }));
      gw._audit({ type: 'chain_archive_listed', bot: ctx.bot.name, count: manifests.length });
      return send(res, 200, { archives: manifests });
    }

    if (req.method === 'POST') {
      if (!archive.archiveEnabled()) {
        return send(res, 501, { error: 'archive_disabled', detail: 'set TG_CHAIN_ARCHIVE=1' });
      }
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return send(res, 400, { error: 'invalid_json' });
      }
      let before;
      if (body.beforeIso !== undefined) {
        if (typeof body.beforeIso !== 'string') {
          return send(res, 400, { error: 'invalid_beforeIso' });
        }
        before = Date.parse(body.beforeIso);
        if (!Number.isFinite(before)) {
          return send(res, 400, { error: 'invalid_beforeIso' });
        }
      }
      const out = archive.archiveChain(before, { chain: gw.chain });
      if (out.refused) {
        gw._audit({ type: 'chain_archive_refused', bot: ctx.bot.name, reason: out.reason, length: out.length });
        getAlertSink(gw).alert('chain_archive_refused', { reason: out.reason, length: out.length });
        return send(res, 409, { error: 'archive_refused', reason: out.reason, length: out.length });
      }
      if (out.inert) {
        return send(res, 501, { error: 'archive_disabled', detail: 'set TG_CHAIN_ARCHIVE=1' });
      }
      if (out.archivedCount === 0) {
        // Idempotent no-op: nothing old enough to archive — audited, no manifest.
        gw._audit({ type: 'chain_archived', bot: ctx.bot.name, archivedCount: 0 });
        return send(res, 200, { archivedCount: 0, manifestKey: null });
      }
      gw._audit({
        type: 'chain_archived',
        bot: ctx.bot.name,
        archivedCount: out.archivedCount,
        manifestKey: out.manifestKey,
        headBefore: out.manifest.headBefore,
        headAfter: out.manifest.headAfter,
      });
      return send(res, 200, { archivedCount: out.archivedCount, manifestKey: out.manifestKey });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
