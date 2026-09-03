// FS-K3 — obsv history mounts (capture + history query). Operator-only.

const { captureSnapshot, queryHistory, enabled, cleanupOldSnapshots } = require('../obsv-history');
const { isOperator } = require('../tenants');
const { audit } = require('../events');
const { snapshot: buildSnapshot } = require('../obsv');

module.exports = function mountObsvHistory(gw) {
  gw.router.post('/v2/observability/capture', async (req, res) => {
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'obsv_history_disabled' })); }
    const op = isOperator(req);
    if (!op) {
      audit('obsv_snapshot_capture_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    let snap = buildSnapshot(gw);
    if (snap && snap.snapshot) snap = snap.snapshot; // unwrap {ok,snapshot} if present
    const result = captureSnapshot(snap || {});
    if (result && result.error === 'snapshot_too_large') {
      res.statusCode = 413;
      return res.end(JSON.stringify(result));
    }
    audit('obsv_snapshot_captured', { by: op.name, id: result?.id });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });

  gw.router.get('/v2/observability/history', async (req, res) => {
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'obsv_history_disabled' })); }
    const op = isOperator(req);
    if (!op) {
      audit('obsv_history_read_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const filters = {
      since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
      until: url.searchParams.has('until') ? Number(url.searchParams.get('until')) : undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    };
    const rows = queryHistory(filters);
    audit('obsv_history_read', { by: op.name, count: rows.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: rows.length, rows }));
  });

  gw.router.post('/v2/observability/cleanup', async (req, res) => {
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'obsv_history_disabled' })); }
    const op = isOperator(req);
    if (!op) {
      audit('obsv_snapshot_cleanup_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const result = cleanupOldSnapshots();
    audit('obsv_snapshot_cleanup', { by: op.name, deletedCount: result.deletedCount });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
