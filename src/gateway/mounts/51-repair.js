'use strict';
// mount: GET /v2/repair/diagnose — W10 self-repair surface.
// Read-only diagnosis of the audit chain. On tamper the caller gets 503 with
// {ok:false, repaired:false, quarantine:"quarantine-<ts>.json"}. The repair
// action is diagnosis + quarantine ONLY — never a silent hash rewrite
// (re-sealing a broken chain destroys the tamper-evidence it exists for).
const { send } = require('../server');
const { getRepair } = require('../selfrepair');

module.exports = {
  name: 'v2-repair-diagnose',
  method: 'GET',
  path: '/v2/repair/diagnose',
  auth: 'bearer',
  handle: async (gw, req, res) => {
    const r = getRepair(gw);
    let report;
    try {
      report = r.diagnose();
    } catch (e) {
      return send(res, 500, { ok: false, error: 'diagnose_failed', message: e.message });
    }
    if (report.ok) return send(res, 200, report);
    // Fail closed: a broken chain is a broken gateway. 503 + quarantine name.
    send(res, 503, {
      ok: false,
      repaired: false,
      quarantine: report.quarantine,
      failedSeq: report.failedSeq,
      reason: report.reason,
      note: report.note,
    });
  },
};