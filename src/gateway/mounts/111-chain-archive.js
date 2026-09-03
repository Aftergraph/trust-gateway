'use strict';
// FS-I7 mount — chain compaction / archival HTTP surface.
//
//   GET  /v2/chain/archive → list archive manifests (operator only)
//   POST /v2/chain/archive {beforeIso?} → trigger archival (operator only)
//
// FS-J3 — restore drill surface:
//   GET  /v2/chain/archive/:manifestKey → manifest details BEFORE restore
//   POST /v2/chain/archive/:manifestKey/restore → restoreArchive (operator only)
//
// SECURITY: operator-only (same isOperator gate as 110-backup). Refusals
// and denials are audited; success audits carry COUNTS and manifest keys
// only — never entry payloads, never file contents.
//
// GATING: POST /restore and POST (archive) are INERT unless
// TG_CHAIN_ARCHIVE=1 (module gate answers 501 archive_disabled); GET always
// works for operators (manifests may exist from earlier runs or a warm
// restore).

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
  path: /^\/v2\/chain\/archive(?:\/([^/]+)(?:\/restore)?)?\/?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'chain_archive_refused', bot: ctx.bot && ctx.bot.name, reason: 'operator_required' });
      return send(res, 403, { error: 'operator_required' });
    }

    const seg = ctx.params.matches ? ctx.params.matches[1] : null;
    const isRestore = Boolean(seg) && /\/restore$/.test(ctx.url.pathname.replace(/\/+$/, ''));

    if (req.method === 'GET' && !seg) {
      const { KV } = require('../kvstore');
      const kv = new KV({ db: gw.chain && gw.chain.db });
      const manifests = (kv.list('archive:chain:') || []).map((r) => ({
        key: r.key,
        ...(r.value || {}),
      }));
      gw._audit({ type: 'chain_archive_listed', bot: ctx.bot.name, count: manifests.length });
      return send(res, 200, { archives: manifests });
    }

    // ── GET /v2/chain/archive/:manifestKey — manifest details ────────
    // FS-J3: shows what WOULD be restored before the operator pulls the
    // trigger. Metadata only — never the archived payloads themselves.
    if (req.method === 'GET' && seg && !isRestore) {
      const { KV } = require('../kvstore');
      const kv = new KV({ db: gw.chain && gw.chain.db });
      const m = kv.get(`archive:chain:${seg}`);
      if (!m) return send(res, 404, { error: 'manifest_not_found', manifestKey: `archive:chain:${seg}` });
      return send(res, 200, {
        key: `archive:chain:${seg}`,
        file: m.file,
        count: m.count,
        headBefore: m.headBefore,
        headAfter: m.headAfter,
        archivedAt: m.archivedAt,
        sha256: m.sha256,
        beforeTs: m.beforeTs,
        chainId: m.chainId,
        lastRestore: m.lastRestore || null,
        restoreEndpoint: `/v2/chain/archive/${seg}/restore`,
      });
    }

    // ── POST /v2/chain/archive/:manifestKey/restore — FS-J3 ─────────
    if (req.method === 'POST' && seg && isRestore) {
      if (!archive.archiveEnabled()) {
        return send(res, 501, { error: 'archive_disabled', detail: 'set TG_CHAIN_ARCHIVE=1' });
      }
      const manifestKey = `archive:chain:${seg}`;
      try {
        const out = archive.restoreArchive(manifestKey, { chain: gw.chain });
        if (out.inert) {
          return send(res, 501, { error: 'archive_disabled', detail: 'set TG_CHAIN_ARCHIVE=1' });
        }
        if (out.refused) {
          gw._audit({
            type: 'chain_restore_refused',
            bot: ctx.bot.name,
            manifestKey,
            reason: out.reason,
            length: out.length,
            archiveEntries: out.archiveEntries,
          });
          getAlertSink(gw).alert('chain_restore_refused', {
            reason: out.reason,
            length: out.length,
            archiveEntries: out.archiveEntries,
          });
          return send(res, 409, {
            error: 'restore_refused',
            reason: out.reason,
            length: out.length,
            archiveEntries: out.archiveEntries,
          });
        }
        gw._audit({
          type: 'chain_restored',
          bot: ctx.bot.name,
          manifestKey,
          restoredCount: out.restoredCount,
          skippedDuplicates: out.skippedDuplicates,
          newHead: out.newHead,
        });
        return send(res, 200, {
          restoredCount: out.restoredCount,
          skippedDuplicates: out.skippedDuplicates,
          newHead: out.newHead,
        });
      } catch (err) {
        // Fail-closed (manifest missing/corrupt, checksum mismatch): the
        // module guarantees the live DB was untouched — audit the refusal
        // honestly with the error code, then answer 409.
        gw._audit({
          type: 'chain_restore_refused',
          bot: ctx.bot.name,
          manifestKey,
          reason: err.code || 'restore_failed',
          error: String(err.message || err).slice(0, 300),
        });
        getAlertSink(gw).alert('chain_restore_refused', { reason: err.code || 'restore_failed' });
        return send(res, 409, { error: 'restore_refused', reason: err.code || 'restore_failed' });
      }
    }

    if (req.method === 'POST' && !seg) {
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
