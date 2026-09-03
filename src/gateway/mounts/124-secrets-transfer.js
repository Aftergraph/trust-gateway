// FS-L1 — tenant-to-tenant secret transfer mount. Operator-only.

const { transferSecret, enabled } = require('../secrets-transfer');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountSecretsTransfer(gw) {
  gw.router.post('/v2/secrets/transfer', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('secret_transfer_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_json' })); }

      if (!enabled()) {
        audit('secret_transfer_denied', { bot: op.name, reason: 'vault_disabled' });
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: 'transfer_disabled' }));
      }

      try {
        const result = transferSecret({
          fromTenant: parsed.fromTenant,
          toTenant: parsed.toTenant,
          key: parsed.key,
          reason: parsed.reason,
          by: op.name,
        });
        audit('secret_transferred', {
          fromTenant: result.fromTenant,
          toTenant: result.toTenant,
          key: result.key,
          reason: parsed.reason,
          by: op.name,
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ok: true,
          key: result.key,
          fromTenant: result.fromTenant,
          toTenant: result.toTenant,
          transferredAt: result.transferredAt,
        }));
      } catch (err) {
        const code = err.code || 'transfer_failed';
        const statusByCode = {
          same_tenant: 400, invalid_key: 400, missing_reason: 400,
          reason_too_long: 400, invalid_tenant: 400, missing_fields: 400,
          source_missing: 404, dest_conflict: 409,
          dest_write_failed: 500, source_delete_failed: 500,
        };
        audit('secret_transfer_denied', { bot: op.name, reason: code });
        res.statusCode = statusByCode[code] || 500;
        res.end(JSON.stringify({ error: code }));
      }
    });
  });
};
