'use strict';
// FS-B1 mount — verified backup/restore HTTP surface.
//
//   GET  /v2/backup                 → list backups (name, createdAt, files count) — operator only
//   POST /v2/backup                 → createBackup now + chain facts → 201 {dir, manifest}
//   POST /v2/backup/restore         → {dir|name} verify+restore → 200 {restored:[...]} — operator only
//
// SECURITY: every route is operator-only (role 'operator' or '*' cap), same
// check as 100-telemetry. Restore RE-VERIFIES sha256s inside backup.js
// (defense in depth — the mount never trusts the client, the module never
// trusts the disk). Each action is audited via gw._audit with counts only —
// never file contents, never paths outside the data dir.

const path = require('node:path');
const { send, readBody } = require('../server');
const backup = require('../backup');
// FS-G3: out-of-band alarmering — module-level sink (server.js is untouched).
const { getAlertSink } = require('../alerting');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'backup',
  method: '*',
  path: /^\/v2\/backup(\/restore)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'backup_denied', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    const sub = ctx.params.matches ? ctx.params.matches[1] : null;

    // ── GET /v2/backup — list ────────────────────────────────────────
    if (req.method === 'GET' && !sub) {
      const names = backup.listBackupNames();
      const list = names.map((n) => {
        const dir = path.join(backup.backupsDir ? backup.backupsDir() : path.join(process.cwd(), 'data', 'backups'), n);
        let manifest = null;
        try { manifest = backup.readManifest(dir); } catch { /* unreadable → still listed, manifest null */ }
        return {
          name: n,
          createdAt: manifest ? manifest.createdAt : null,
          chainHead: manifest ? manifest.chainHead : null,
          files: manifest ? manifest.files.length : null,
        };
      });
      return send(res, 200, { backups: list });
    }

    // ── POST /v2/backup — create ─────────────────────────────────────
    if (req.method === 'POST' && !sub) {
      const { dir, manifest } = backup.withChainFacts(
        backup.createBackup(),
        gw.chain
      );
      gw._audit({
        type: 'backup_created',
        files: manifest.files.length,
        chainHead: manifest.chainHead,
      });
      return send(res, 201, { dir: path.basename(dir), manifest });
    }

    // ── POST /v2/backup/restore {name|dir} ───────────────────────────
    if (req.method === 'POST' && sub === '/restore') {
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch { return send(res, 400, { error: 'invalid_json' }); }
      const name = typeof body.name === 'string' ? body.name : '';
      if (!/^backup-[\d-]+T[\d-]+Z$/.test(name)) {
        return send(res, 400, { error: 'invalid_name' });
      }
      const dir = path.join(process.cwd(), 'data', 'backups', name);
      try {
        const out = backup.restore(dir);
        gw._audit({
          type: 'backup_restored',
          name,
          files: out.restored.length,
          chainHead: out.manifest.chainHead,
        });
        return send(res, 200, { restored: out.restored, chainHead: out.manifest.chainHead });
      } catch (e) {
        const reason = String(e && e.message).slice(0, 120);
        gw._audit({ type: 'backup_restore_refused', name, reason });
        // FS-G3: restore refused is an operator-grade signal — the audit
        // entry alone is not enough. Best-effort webhook alert, counts +
        // types only (name/reason are already in the audit chain).
        getAlertSink(gw).alert('backup_restore_refused', { name, reason });
        return send(res, 409, { error: 'restore_refused', detail: String(e && e.message) });
      }
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
