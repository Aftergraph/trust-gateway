// FS-Z4 — backup encryption at rest mount. Operator-only.

const bc = require('../backup-crypto');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountBackupCrypto(gw) {
  gw.router.get('/v2/backup/encryption/status', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('backup_crypto_status_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    audit('backup_crypto_status_read', { by: op.name, enabled: bc.enabled() });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ enabled: bc.enabled(), algo: bc.enabled() ? bc.ALGO : null }));
  });
};
