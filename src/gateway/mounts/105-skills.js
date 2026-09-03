'use strict';
// FS-C1 mount: skills as first-class governed objects.
// FS-F1 extension: skills self-service for non-operators.
//
// Routes (all bearer, RBAC — see skillsAccessLevel in ../skills):
//   operator (role) or 'skill.author' cap → full FS-C1 behavior, unchanged.
//   'skills.own' cap → self-service ONLY:
//     create (forced owner=bot.name), list/get/patch/delete OWN skills,
//     run OWN skills with ?dry=1 only. Non-owned records are 404
//     (anti-enumeration); a non-dry run is 403 skill_denied audited.
//   neither → 403 { error: 'skill_owner_required' }, audited skill_denied.
//
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
// Audit: skill_created + skill_run_started (own TRANSPARENCY rows) +
// skill_denied (FS-F1: RBAC / dry-only refusals, {bot, skillId?, action}).
// Per-step governance rides the EXISTING chat_action rows:
//   {type:'chat_action', kind:'skill_step', skillId, seq, tool, decision}
// — no raw args ever enter the chain (argsLength only).

const { send, readBody } = require('../server');
const { getSkillStore, resolveTemplate, skillsAccessLevel, isOwnSkill } = require('../skills');
const { classify, decide } = require('../policy');

// FS-F1: access tier — 'operator' | 'author' | 'self' | null (see skills.js).
function skillAuthorAllowed(bot) {
  return skillsAccessLevel(bot) !== null;
}

// Which action a request is attempting (for skill_denied audit rows).
function routeAction(method, segs, isRun) {
  if (method === 'GET') return segs.length >= 3 ? 'read' : 'list';
  if (method === 'POST') return isRun ? 'run' : 'create';
  if (method === 'PATCH') return 'patch';
  if (method === 'DELETE') return 'delete';
  return method.toLowerCase();
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
    const access = skillsAccessLevel(bot);

    if (!skillAuthorAllowed(bot)) {
      gw._audit({ type: 'skill_denied', bot: bot && bot.name, action: routeAction(req.method, segs, isRun) });
      return send(res, 403, { error: 'skill_owner_required' });
    }
    // FS-F1: 'self' tier — ownership-scoped self-service. operator/author
    // take the unchanged FS-C1 paths below.
    const selfService = access === 'self';

    try {
      // ── GET /v2/skills — list (governed skills + module-provided skills) ──
      if (req.method === 'GET' && !id) {
        // Self-service: owner filter — only the bot's own skills. Module
        // skills are not its records, so hub discovery is skipped entirely.
        if (selfService) {
          const own = store.list().filter((s) => isOwnSkill(s, bot));
          return send(res, 200, { skills: own });
        }
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
        // Self-service: 404 (anti-enum) on someone else's or missing skill.
        if (!skill || (selfService && !isOwnSkill(skill, bot))) return send(res, 404, { error: 'not_found' });
        return send(res, 200, skill);
      }

      // ── POST /v2/skills — create (NOT /:id/run, handled below) ──
      if (req.method === 'POST' && !id && !isRun) {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const { name, version, description, steps, createdBy } = body || {};
        // FS-F1: self-service creates are scoped owner=bot.name — a worker
        // can never mint a skill that looks like someone else created it.
        const creator = selfService ? bot.name : (createdBy || bot.name);
        const skill = store.create({ name, version, description, steps, createdBy: creator });
        gw._audit({ type: 'skill_created', skillId: skill.id, name: skill.name, version: skill.version, createdBy: creator, owner: creator });
        return send(res, 201, skill);
      }

      // ── PATCH /v2/skills/:id — edit ──
      if (req.method === 'PATCH' && id && !isRun) {
        const current = store.get(id);
        // Self-service: 404 (anti-enum) on someone else's or missing skill.
        if (!current || (selfService && !isOwnSkill(current, bot))) return send(res, 404, { error: 'not_found' });
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const updated = store.update(id, body || {});
        return send(res, 200, updated);
      }

      // ── DELETE /v2/skills/:id — remove ──
      if (req.method === 'DELETE' && id && !isRun) {
        const current = store.get(id);
        // Self-service: ownership enforced — cannot delete someone else's.
        if (!current || (selfService && !isOwnSkill(current, bot))) return send(res, 404, { error: 'not_found' });
        const removed = store.remove(id);
        return send(res, 200, { id: removed.id, name: removed.name });
      }

      // ── POST /v2/skills/:id/run — governed execution (or ?dry=1 plan) ──
      if (req.method === 'POST' && isRun) {
        const skill = store.get(id);
        // Self-service: 404 (anti-enum) on someone else's or missing skill.
        if (!skill || (selfService && !isOwnSkill(skill, bot))) return send(res, 404, { error: 'not_found' });

        const dry = url.searchParams.get('dry') === '1';
        // FS-F1: self-service runs are dry-only — the approval-gated live run
        // stays operator/author-only (FS-C1). Refusal is audited.
        if (selfService && !dry) {
          gw._audit({ type: 'skill_denied', bot: bot.name, skillId: skill.id, action: 'run' });
          return send(res, 403, { error: 'dry_run_only' });
        }

        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const args = (body && body.args) || {};

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
