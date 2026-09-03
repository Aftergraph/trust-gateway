// FS-W4 — skill dependency validation mount. Operator-only.

const deps = require('../skill-deps');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountSkillDeps(gw) {
  gw.router.post('/v2/skills/validate-deps', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!deps.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'skill_deps_disabled' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const skill = parsed.skill;
      if (!skill || typeof skill !== 'object') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_skill' })); }
      const strict = !!parsed.strict;
      const v = deps.validate(skill, { strict });
      let cycle = null;
      if (v.ok && Array.isArray(skill.requires)) {
        cycle = deps.detectCycle(skill.id, skill.requires);
        if (cycle.hasCycle) { v.ok = false; v.error = 'cycle_detected'; v.cycle = cycle.path; }
      }
      if (!v.ok) {
        audit('skill_deps_rejected', { by: op.name, skillId: skill.id, reason: v.error });
        res.statusCode = 400;
        return res.end(JSON.stringify(v));
      }
      audit('skill_deps_validated', { by: op.name, skillId: skill.id, requires: v.requires });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(v));
    });
  });
};
