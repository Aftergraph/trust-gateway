// FS-M2 — skill version mounts. Operator-only.

const versions = require('../skill-versions');
const skills = require('../skills');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountSkillVersions(gw) {
  gw.router.get('/v2/skills/:id/versions', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('skill_version_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!versions.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'skill_versions_disabled' }));
    }
    const m = req.url.match(/^\/v2\/skills\/([^/]+)\/versions/);
    const skillId = m ? decodeURIComponent(m[1]) : null;
    if (!skillId) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_skill' })); }
    const list = versions.listVersions(skillId);
    audit('skill_version_read', { by: op.name, skillId, count: list.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: list.length, versions: list }));
  });

  gw.router.get('/v2/skills/:id/versions/:version', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('skill_version_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!versions.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_versions_disabled' })); }
    const m = req.url.match(/^\/v2\/skills\/([^/]+)\/versions\/(\d+)/);
    const skillId = m ? decodeURIComponent(m[1]) : null;
    const version = m ? Number(m[2]) : null;
    if (!skillId || !version) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_input' })); }
    const v = versions.getVersion(skillId, version);
    if (!v) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    audit('skill_version_read', { by: op.name, skillId, version });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(v));
  });

  gw.router.post('/v2/skills/:id/rollback', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('skill_rollback_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!versions.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_versions_disabled' })); }
    const m = req.url.match(/^\/v2\/skills\/([^/]+)\/rollback/);
    const skillId = m ? decodeURIComponent(m[1]) : null;
    if (!skillId) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_skill' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const version = Number(parsed.version);
      if (!Number.isInteger(version) || version < 1) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_version' }));
      }
      const v = versions.rollbackTo(skillId, version);
      if (!v) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
      // Restore the skill's steps in the live skills store
      try {
        skills.updateSteps(skillId, v.steps);
      } catch (err) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: 'update_failed', message: String(err.message || err) }));
      }
      // Snapshot the rollback itself as a new version (history of changes)
      try { versions.snapshot(skillId, v.steps, op.name); } catch {}
      audit('skill_rolled_back', { by: op.name, skillId, version });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, skillId, version, steps: v.steps }));
    });
  });
};
