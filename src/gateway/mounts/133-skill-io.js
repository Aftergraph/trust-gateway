// FS-O1 — skills import/export mounts. Operator-only.

const io = require('../skill-io');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountSkillIO(gw) {
  gw.router.get('/v2/skills/:id/export', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('skill_io_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!io.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_io_disabled' })); }
    const m = req.url.match(/^\/v2\/skills\/([^/]+)\/export/);
    const id = m ? decodeURIComponent(m[1]) : null;
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_skill' })); }
    const exp = io.exportSkill(id);
    if (!exp) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    audit('skill_exported', { by: op.name, skillId: id });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(exp));
  });

  gw.router.get('/v2/skills/export-all', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!io.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_io_disabled' })); }
    const all = io.exportAll();
    audit('skill_bulk_exported', { by: op.name, count: all?.skills?.length || 0 });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(all));
  });

  gw.router.post('/v2/skills/import', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!io.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_io_disabled' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_json' })); }
      if (Array.isArray(parsed)) {
        // Bulk import
        const r = io.importBulk(parsed, op.name);
        audit('skill_bulk_imported', { by: op.name, ok: r.ok, failed: r.failed });
        return res.end(JSON.stringify(r));
      }
      // Single import
      const r = io.importSkill(parsed, op.name);
      if (!r.ok) {
        audit('skill_import_denied', { by: op.name, error: r.error });
        res.statusCode = 400;
        return res.end(JSON.stringify(r));
      }
      audit('skill_imported', { by: op.name, id: r.id });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });
};
