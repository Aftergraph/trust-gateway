'use strict';
// FS-C1 mount: skills as first-class governed objects.
//
// Routes (all bearer, RBAC: operator role OR capability 'skill.author'):
//   GET    /v2/skills                → list skills
//   GET    /v2/skills/:id            → get one skill
//   POST   /v2/skills                → create {name, version, description, steps, createdBy}
//   PATCH  /v2/skills/:id            → edit {name?, version?, description?, steps?}
//   DELETE /v2/skills/:id            → remove
//   POST   /v2/skills/:id/run {args} → run steps through the EXISTING
//                                     governed path (gw.dispatch + policy
//                                     classify/decide + approvals). A
//                                     destructive step still parks as an
//                                     approval — NEVER direct execution.
//   ?dry=1 on run returns the plan without executing anything.
//
// Audit: skill_created + skill_run_started (own TRANSPARENCY rows).
// Per-step governance rides the EXISTING chat_action rows:
//   {type:'chat_action', kind:'skill_step', skillId, seq, tool, decision}
// — no raw args ever enter the chain (argsLength only).

const { send, readBody } = require('../server');
const { getSkillStore, resolveTemplate } = require('../skills');
const { classify, decide } = require('../policy');

// RBAC: operator role, or the bot explicitly holds the 'skill.author' cap.
function skillAuthorAllowed(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('skill.author');
}

module.exports = {
  name: 'v2-skills',
  method: '*',
  path: /^\/v2\/skills(?:\/.*)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot;
    const url = ctx.url;
    const pathname = url.pathname;
    const store = getSkillStore(gw);
    const segs = pathname.split('/').filter(Boolean); // ['v2','skills', ...]
    const id = segs.length >= 3 ? decodeURIComponent(segs[2]) : null;
    const isRun = segs.length === 4 && segs[3] === 'run';

    if (!skillAuthorAllowed(bot)) {
      return send(res, 403, { error: 'forbidden — requires operator role or skill.author capability' });
    }

    try {
      // ── GET /v2/skills — list (governed skills + module-provided skills) ──
      if (req.method === 'GET' && !id) {
        const merged = { skills: [...store.list()] };
        // FS-C1 owns /v2/skills; module skills (W4 discovery) ride the same
        // surface so agents see one skill list. Hub unavailable → governed only.
        try {
          const { getPluginsHub } = require('../plugins');
          const hub = getPluginsHub(gw);
          const { skills, rejected } = hub.discoverSkills();
          merged.skills.push(...skills.map((s) => ({
            module: s.module, file: s.file, name: s.name,
            description: s.description, trigger: s.trigger,
          })));
          merged.rejected = rejected;
        } catch { /* no plugin hub on this gateway */ }
        return send(res, 200, merged);
      }

      // ── GET /v2/skills/:id ──
      if (req.method === 'GET' && id && !isRun) {
        const skill = store.get(id);
        if (!skill) return send(res, 404, { error: 'not_found' });
        return send(res, 200, skill);
      }

      // ── POST /v2/skills — create (NOT /:id/run, handled below) ──
      if (req.method === 'POST' && !id && !isRun) {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const { name, version, description, steps, createdBy } = body || {};
        const creator = createdBy || bot.name;
        const skill = store.create({ name, version, description, steps, createdBy: creator });
        gw._audit({ type: 'skill_created', skillId: skill.id, name: skill.name, version: skill.version, createdBy: creator });
        return send(res, 201, skill);
      }

      // ── PATCH /v2/skills/:id — edit ──
      if (req.method === 'PATCH' && id && !isRun) {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const updated = store.update(id, body || {});
        return send(res, 200, updated);
      }

      // ── DELETE /v2/skills/:id — remove ──
      if (req.method === 'DELETE' && id && !isRun) {
        const removed = store.remove(id);
        return send(res, 200, { id: removed.id, name: removed.name });
      }

      // ── POST /v2/skills/:id/run — governed execution (or ?dry=1 plan) ──
      if (req.method === 'POST' && isRun) {
        const skill = store.get(id);
        if (!skill) return send(res, 404, { error: 'not_found' });

        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const args = (body && body.args) || {};
        const dry = url.searchParams.get('dry') === '1';

        // Resolve every step's args up-front (placeholder substitution +
        // metachar rejection). Any failure aborts before ANY step runs.
        const plan = [];
        for (let i = 0; i < skill.steps.length; i++) {
          const step = skill.steps[i];
          let resolved;
          try {
            resolved = resolveTemplate(step.argsTemplate, args);
          } catch (e) {
            if (String(e && e.code) === 'bad_request') {
              return send(res, 400, { error: 'bad_request', detail: e.message });
            }
            throw e;
          }
          plan.push({
            seq: i + 1,
            tool: step.tool,
            args: resolved,
            cls: classify(step.tool),
            approvalHint: step.approvalHint || '',
          });
        }

        const runSeq = `skrun_${gw.chain.head.seq + 1}`;
        gw._audit({ type: 'skill_run_started', skillId: skill.id, name: skill.name, bot: bot.name, steps: skill.steps.length, dry, runId: runSeq });

        if (dry) {
          return send(res, 200, { skillId: skill.id, runId: runSeq, dry: true, status: 'planned', plan });
        }

        const results = [];
        let status = 'completed';
        let completed = 0;
        for (const item of plan) {
          const { seq, tool, args, cls } = item;
          const verdict = decide({ tool, cls, bot });
          // Per-step governance rides the existing chat_action audit rows.
          gw._audit({
            type: 'chat_action', kind: 'skill_step', skillId: skill.id, runId: runSeq,
            seq, bot: bot.name, tool, class: cls,
            decision: verdict.decision, reason: verdict.reason,
            argsLength: JSON.stringify(args).length,
          });

          if (verdict.decision === 'allow' && gw.dispatch) {
            try {
              const result = await gw.dispatch(bot.name, tool, args);
              gw._audit({ type: 'chat_action_executed', kind: 'skill_step', skillId: skill.id, seq, bot: bot.name, tool, ok: true });
              results.push({ seq, tool, decision: 'allow', result });
              completed = seq;
            } catch (e) {
              gw._audit({ type: 'chat_action_executed', kind: 'skill_step', skillId: skill.id, seq, bot: bot.name, tool, ok: false, error: String(e && e.message).slice(0, 200) });
              results.push({ seq, tool, decision: 'allow', error: 'dispatch_failed' });
              status = 'failed';
              break;
            }
          } else if (verdict.decision === 'needs_approval') {
            const approval = gw.approvals.request({ bot: { name: bot.name }, tool, args, reason: `skill ${skill.id} step ${seq}: ${verdict.reason}` });
            gw._audit({ type: 'approval_requested', approvalId: approval.id, bot: bot.name, tool, class: cls });
            results.push({ seq, tool, decision: 'needs_approval', approvalId: approval.id });
            status = 'parked'; // later steps wait for this approval
            break;
          } else {
            results.push({ seq, tool, decision: verdict.decision, reason: verdict.reason });
            status = 'denied';
            break;
          }
        }

        return send(res, 200, { skillId: skill.id, runId: runSeq, status, completed, steps: results });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (String(e && e.code) === 'bad_request') return send(res, 400, { error: 'bad_request', detail: e.message });
      if (String(e && e.code) === 'conflict') return send(res, 409, { error: 'conflict', detail: e.message });
      if (String(e && e.code) === 'not_found') return send(res, 404, { error: 'not_found' });
      if (String(e && e.message) === 'body_too_large') return send(res, 413, { error: 'body_too_large' });
      return send(res, 500, { error: 'internal_error' });
    }
  },
};
