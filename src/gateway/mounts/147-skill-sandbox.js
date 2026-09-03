// FS-X2 — skill sandbox profile mounts. Operator-only.

const sb = require('../skill-sandbox');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountSkillSandbox(gw) {
  gw.router.put('/v2/skills/:id/sandbox', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!sb.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_sandbox_disabled' })); }
    const m = req.url.match(/^\/v2\/skills\/([^/]+)\/sandbox/);
    const skillId = m ? decodeURIComponent(m[1]) : null;
    if (!skillId) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_skill' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const r = sb.set(skillId, parsed, op.name);
      if (!r || !r.ok) {
        res.statusCode = 400;
        return res.end(JSON.stringify(r || { error: 'set_failed' }));
      }
      audit('skill_sandbox_set', { by: op.name, skillId, network: r.network, fsWrite: r.fsWrite });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });

  gw.router.get('/v2/skills/:id/sandbox', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!sb.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_sandbox_disabled' })); }
    const m = req.url.match(/^\/v2\/skills\/([^/]+)\/sandbox/);
    const skillId = m ? decodeURIComponent(m[1]) : null;
    if (!skillId) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_skill' })); }
    const r = sb.get(skillId);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(r || { skillId, profile: null }));
  });

  gw.router.delete('/v2/skills/:id/sandbox', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!sb.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_sandbox_disabled' })); }
    const m = req.url.match(/^\/v2\/skills\/([^/]+)\/sandbox/);
    const skillId = m ? decodeURIComponent(m[1]) : null;
    if (!skillId) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_skill' })); }
    const removed = sb.remove(skillId);
    audit('skill_sandbox_reset', { by: op.name, skillId, removed });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, removed }));
  });

  gw.router.get('/v2/skills/sandbox-profiles', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!sb.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_sandbox_disabled' })); }
    const rows = sb.list();
    audit('skill_sandbox_listed', { by: op.name, count: rows.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: rows.length, profiles: rows }));
  });
};
