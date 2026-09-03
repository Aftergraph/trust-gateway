'use strict';
// FS-C1 mount: skills as first-class governed objects.
// FS-F1 extension: skills self-service for non-operators.
// FS-F4 extension: skills marketplace — publish/unpublish, a read-only
// shared catalog, and cross-bot dry-runs of shared skills.
// FS-G1 extension: cross-tenant skills FEDERATION — env-gated
// (TG_SKILLS_FEDERATION=1), read-only cross-tenant, running-tenant
// approvals. See the full federation model in ../skills.js (header).
//
// VISIBILITY (FS-F4): every skill has `visibility` — 'private' (default,
// byte-identical to pre-FS-F4 behavior) or 'shared'. A shared skill is
// visible to OTHER bots on the SAME gateway for GET and ?dry=1 run; it is
// never PATCH/DELETE-able by a non-owner, and a real (non-dry) run stays
// approval-gated exactly as before.
//
// FEDERATION (FS-G1): visibility gains a third value 'federated', set ONLY
// by the OWNING tenant's OPERATOR via the audited federate route. With the
// env ON:
//   • GET /v2/skills/federated — the federated catalog for the CALLING
//     tenant: {id, name, version, ownerTenant, ownerBot, description} —
//     NO steps, read-only discovery.
//   • Bots of OTHER tenants can dry-run a federated skill; every such
//     cross-tenant run is audited skill_run_started with BOTH tags:
//     tenantAuditTag(running tenant) AND federatedFrom: <owner-tenant-id>.
//   • REAL (non-dry) runs still flow the existing governed path; approval
//     parks land in the RUNNING tenant's scoped approval store (its own
//     operator approves) — never the owner's store.
//   • Edits/delete/publish/unpublish stay OWNER-TENANT-only: a cross-
//     tenant attempt is a uniform 404 (anti-enumeration) audited as
//     skill_federation_denied.
//   • The owner-tenant skill record is READ-ONLY for the running tenant.
// With the env OFF (default) 'federated' behaves EXACTLY like 'shared':
// same catalog dry-run semantics, no federation routes (404), no
// ownerTenant stamping, untagged chain payloads — a byte-identical
// off-switch for main single-tenant behavior.
//
// Routes (all bearer, RBAC — see skillsAccessLevel in ../skills):
//   operator (role) or 'skill.author' cap → full FS-C1 behavior, unchanged.
//   'skills.own' cap → self-service ONLY:
//     create (forced owner=bot.name), list/get/patch/delete OWN skills,
//     run OWN skills with ?dry=1 only. Non-owned PRIVATE records are 404
//     (anti-enumeration, unchanged); non-owned SHARED records are
//     readable + dry-runnable but NOT editable (404) and their real run
//     is 403 skill_denied audited. A non-dry run is 403 skill_denied audited.
//   neither → 403 { error: 'skill_owner_required' }, audited skill_denied.
//
//   GET    /v2/skills                → list skills
//   GET    /v2/skills/shared         → read-only marketplace projection
//                                     {id, name, version, owner, visibility}
//                                     of every shared skill (no steps,
//                                     no description, no owner bookkeeping
//                                     beyond `owner`) — FS-F4
//   GET    /v2/skills/federated      → FS-G1 federated catalog for the
//                                     calling tenant: {id, name, version,
//                                     ownerTenant, ownerBot, description}
//                                     of every federated skill (no steps).
//                                     TG_SKILLS_FEDERATION=1 only, else 404.
//   GET    /v2/skills/:id            → get one skill
//   POST   /v2/skills                → create {name, version, description, steps, createdBy}
//   PATCH  /v2/skills/:id            → edit {name?, version?, description?, steps?}
//   DELETE /v2/skills/:id            → remove
//   POST   /v2/skills/:id/publish    → operator-only: mark a skill 'shared'
//                                     (audited skill_published {id, by})
//   POST   /v2/skills/:id/unpublish  → operator-only: mark it 'private'
//                                     again (audited skill_unpublished {id, by})
//   POST   /v2/skills/:id/federate   → FS-G1, OWNING-tenant operator only:
//                                     mark a skill 'federated' (audited
//                                     skill_federated {id, by, ownerTenant}).
//                                     TG_SKILLS_FEDERATION=1 only, else 404.
//   POST   /v2/skills/:id/unfederate → FS-G1, owning-tenant operator only:
//                                     back to 'private' — 404 anti-enum
//                                     restored cross-tenant (audited
//                                     skill_unfederated {id, by}).
//   POST   /v2/skills/:id/run {args} → run steps through the EXISTING
//                                     governed path (gw.dispatch + policy
//                                     classify/decide + approvals). A
//                                     destructive step still parks as an
//                                     approval — NEVER direct execution.
//   ?dry=1 on run returns the plan without executing anything.
//
// Audit: skill_created + skill_run_started (own TRANSPARENCY rows) +
// skill_denied (FS-F1: RBAC / dry-only refusals, {bot, skillId?, action}) +
// FS-F4: skill_published / skill_unpublished (operator publish toggles,
// {id, by}) + skill_denied on non-operator publish/unpublish attempts +
// FS-G1: skill_federated {id, by, ownerTenant} / skill_unfederated {id, by}
// (owning-tenant operator federation toggles), skill_federation_denied
// {bot, skillId, action} (cross-tenant write attempts — owner-tenant-only
// enforcement, anti-enum 404 to the caller), and skill_run_started rows
// tagged with tenantAuditTag(running tenant) + federatedFrom on every
// cross-tenant dry run of a federated skill.
// Per-step governance rides the EXISTING chat_action rows:
//   {type:'chat_action', kind:'skill_step', skillId, seq, tool, decision}
// — no raw args ever enter the chain (argsLength only).

const { send, readBody } = require('../server');
const crypto = require('node:crypto');
const { getSkillStore, resolveTemplate, skillsAccessLevel, isOwnSkill, isShared, isFederated, isSharedLike, federationEnabled, canViewSkill } = require('../skills');
const { getFedRunLedger, fedRunsPerHour, fedRunsPerSkillHour, WINDOW_MS } = require('../skills-federation');
const { classify, decide } = require('../policy');
const { resolveTenant } = require('../tenant-resolve');
const { tenantAuditTag } = require('../tenant-scope');

// FS-F1: access tier — 'operator' | 'author' | 'self' | null (see skills.js).
function skillAuthorAllowed(bot) {
  return skillsAccessLevel(bot) !== null;
}

// FS-F4: publish/unpublish are operator-only (same gate shape as 112-apikeys).
function isSkillOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

// Which action a request is attempting (for skill_denied audit rows).
function routeAction(method, segs, isRun) {
  if (method === 'GET') return segs.length >= 3 ? 'read' : 'list';
  if (method === 'POST') return isRun ? 'run' : 'create';
  if (method === 'PATCH') return 'patch';
  if (method === 'DELETE') return 'delete';
  return method.toLowerCase();
}

// FS-H2: over a federation dry-run cap → 429 + audited skill_fed_limited.
function fedLimited(res, gw, tenant, skillId, cap, kind) {
  gw._audit({
    type: 'skill_fed_limited',
    runnerTenant: tenant.id,
    skillId,
    cap,
    window: 'hour',
    limitKind: kind,
  });
  return send(res, 429, { error: 'fed_rate_limited' });
}

// FS-I1: sha256 result hash for a cross-tenant REAL run — a correlation
// digest over the (bounded) step results, so the chain never stores raw
// result payloads but an operator can still verify what ran.
function resultHashOf(results) {
  return crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex');
}

// FS-I1: camelCase projection returned by the approve endpoints.
function pendingProjection(row) {
  if (!row) return null;
  return {
    runId: row.id,
    skillId: row.skillId,
    ownerTenant: row.ownerTenant,
    runnerTenant: row.runnerTenant,
    runnerBot: row.runnerBot,
    approvedByOwner: row.approvedByOwner,
    approvedByRunner: row.approvedByRunner,
    executedAt: row.executedAt,
    status: row.executedAt !== null ? 'executed' : (row.approvedByOwner !== null && row.approvedByRunner !== null ? 'approved' : 'pending'),
  };
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

    // FS-G1: resolve the calling tenant (token prefix claim / operator
    // X-Tenant header — bearer auth itself stays where it is). req.bot is
    // exposed for the resolver's operator check (same pattern as
    // 93-memory). Unknown/disabled tenant → 404, never 403 (anti-enum).
    req.bot = bot;
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return send(res, 404, { error: 'not_found' });

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

      // ── GET /v2/skills/shared — FS-F4 read-only marketplace projection ──
      // Available to every tier that can touch the skills surface at all;
      // the projection carries NO steps, NO description — discovery only.
      if (req.method === 'GET' && id === 'shared') {
        const shared = store.list()
          .filter((s) => isShared(s))
          .map((s) => ({ id: s.id, name: s.name, version: s.version, owner: s.createdBy, visibility: s.visibility }));
        return send(res, 200, { skills: shared });
      }

      // ── GET /v2/skills/federated/runs — FS-H2 operator ledger view ──
      // The CALLING tenant's operator sees their tenant's cross-tenant run
      // ledger. Default (runner view): what THEIR bots ran elsewhere.
      // ?owner=1 (owner view): which tenants ran THEIR skills.
      // Scoped strictly to the calling tenant — no ?tenant= parameter, no
      // cross-tenant peeking. Env OFF → 404 like every federation route.
      // NOTE: matched BEFORE the /federated catalog block — segs[3]
      // disambiguates the two /v2/skills/federated* paths.
      if (req.method === 'GET' && id === 'federated' && segs[3] === 'runs') {
        if (!federationEnabled()) return send(res, 404, { error: 'not_found' });
        if (!isSkillOperator(bot)) {
          gw._audit({ type: 'skill_denied', bot: bot.name, skillId: null, action: 'fed_runs' });
          return send(res, 403, { error: 'operator_required' });
        }
        const ledger = getFedRunLedger();
        const ownerView = url.searchParams.get('owner') === '1';
        const runs = ownerView ? ledger.listByOwner(tenant.id) : ledger.listByRunner(tenant.id);
        return send(res, 200, { runs, view: ownerView ? 'owner' : 'runner', tenant: tenant.id });
      }

      // ── GET /v2/skills/federated — FS-G1 federated catalog ──────────
      // The calling tenant's view of the federation: every 'federated'
      // skill, projected to {id, name, version, ownerTenant, ownerBot,
      // description} — NO steps, read-only discovery. Env OFF → uniform
      // 404 (the route simply does not exist; 'federated' behaves as
      // 'shared' everywhere else). Every tier that can touch the skills
      // surface at all may read the catalog — same gate as /shared.
      if (req.method === 'GET' && id === 'federated' && !segs[3]) {
        if (!federationEnabled()) return send(res, 404, { error: 'not_found' });
        const federated = store.list()
          .filter((s) => isFederated(s))
          .map((s) => ({
            id: s.id,
            name: s.name,
            version: s.version,
            ownerTenant: s.ownerTenant || tenant.id,
            ownerBot: s.createdBy,
            description: s.description || '',
          }));
        return send(res, 200, { skills: federated });
      }

      // ── GET /v2/skills/:id ──
      if (req.method === 'GET' && id && !isRun) {
        const skill = store.get(id);
        // FS-F1 (unchanged for private): 404 (anti-enum) on someone else's
        // PRIVATE or missing skill. FS-F4: a SHARED skill owned by someone
        // else is readable by a 'self' tier bot (read-only — edits and
        // non-dry runs stay gated below).
        if (!skill || !canViewSkill(skill, bot, access)) return send(res, 404, { error: 'not_found' });
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
        // FS-G1 owner-tenant read-only: edits stay OWNER-TENANT-only. A
        // cross-tenant edit of a federated skill is a uniform 404
        // (anti-enumeration) audited as skill_federation_denied — the
        // running tenant never mutates the owner's record.
        if (federationEnabled() && isFederated(current) && tenant.id !== (current.ownerTenant || 'main')) {
          gw._audit({ type: 'skill_federation_denied', bot: bot.name, skillId: current.id, action: 'patch' });
          return send(res, 404, { error: 'not_found' });
        }
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
        // FS-G1 owner-tenant read-only: deletes stay OWNER-TENANT-only. A
        // cross-tenant delete of a federated skill is a uniform 404
        // (anti-enumeration) audited as skill_federation_denied.
        if (federationEnabled() && isFederated(current) && tenant.id !== (current.ownerTenant || 'main')) {
          gw._audit({ type: 'skill_federation_denied', bot: bot.name, skillId: current.id, action: 'delete' });
          return send(res, 404, { error: 'not_found' });
        }
        const removed = store.remove(id);
        return send(res, 200, { id: removed.id, name: removed.name });
      }

      // ── POST /v2/skills/:id/publish | /unpublish — FS-F4, operator-only ──
      if (req.method === 'POST' && id && (segs[3] === 'publish' || segs[3] === 'unpublish')) {
        if (!isSkillOperator(bot)) {
          gw._audit({ type: 'skill_denied', bot: bot.name, skillId: id, action: segs[3] });
          return send(res, 403, { error: 'operator_required' });
        }
        // FS-G1 owner-tenant read-only: the marketplace toggles stay
        // OWNER-TENANT-only for FEDERATED skills — a cross-tenant operator
        // could otherwise unpublish someone else's federation. Uniform 404
        // + skill_federation_denied (anti-enumeration).
        const fedCurrent = store.get(id);
        if (fedCurrent && isFederated(fedCurrent) && tenant.id !== (fedCurrent.ownerTenant || 'main')) {
          gw._audit({ type: 'skill_federation_denied', bot: bot.name, skillId: id, action: segs[3] });
          return send(res, 404, { error: 'not_found' });
        }
        const visibility = segs[3] === 'publish' ? 'shared' : 'private';
        const updated = store.setVisibility(id, visibility);
        if (segs[3] === 'publish') {
          gw._audit({ type: 'skill_published', id: updated.id, by: bot.name });
        } else {
          gw._audit({ type: 'skill_unpublished', id: updated.id, by: bot.name });
        }
        return send(res, 200, { id: updated.id, name: updated.name, visibility: updated.visibility });
      }

      // ── POST /v2/skills/:id/federate | /unfederate — FS-G1, operator-only ──
      // Federation toggles are OWNING-TENANT-only: the skill's ownerTenant
      // (stamped at federate time) must match the CALLING tenant, else
      // uniform 404 + skill_federation_denied (anti-enumeration — a cross-
      // tenant operator learns nothing about the id). Env OFF → the routes
      // do not exist (404), byte-identical off-switch.
      if (req.method === 'POST' && id && (segs[3] === 'federate' || segs[3] === 'unfederate')) {
        if (!federationEnabled()) return send(res, 404, { error: 'not_found' });
        if (!isSkillOperator(bot)) {
          gw._audit({ type: 'skill_denied', bot: bot.name, skillId: id, action: segs[3] });
          return send(res, 403, { error: 'operator_required' });
        }
        const current = store.get(id);
        const ownerTenant = (current && current.ownerTenant) || tenant.id;
        if (ownerTenant !== tenant.id) {
          // cross-tenant federation write — owner-tenant-only, 404 anti-enum
          gw._audit({ type: 'skill_federation_denied', bot: bot.name, skillId: id, action: segs[3] });
          return send(res, 404, { error: 'not_found' });
        }
        const updated = segs[3] === 'federate'
          ? store.federate(id, tenant.id)
          : store.unfederate(id);
        if (segs[3] === 'federate') {
          gw._audit({ type: 'skill_federated', id: updated.id, by: bot.name, ownerTenant: updated.ownerTenant || tenant.id });
        } else {
          gw._audit({ type: 'skill_unfederated', id: updated.id, by: bot.name });
        }
        return send(res, 200, { id: updated.id, name: updated.name, visibility: updated.visibility });
      }

      // ── FS-I1: cross-tenant REAL runs — DUAL-approval federation ─────
      // A cross-tenant REAL (non-dry) run of a federated skill requires the
      // explicit approval of BOTH the OWNING tenant's operator AND the
      // RUNNING tenant's operator, BEFORE anything executes. Routes:
      //   POST /v2/skills/federated/runs/request          {skillId, runnerTenant}
      //   POST /v2/skills/federated/runs/:id/approve-owner
      //   POST /v2/skills/federated/runs/:id/approve-runner
      //   POST /v2/skills/federated/runs/:id/execute
      // All operator-only, all env-gated (TG_SKILLS_FEDERATION=1 → else 404,
      // the byte-identical off-switch). Every attempt is audited; a premature
      // execute is 403 + skill_fed_real_denied and executes NOTHING.
      if (req.method === 'POST' && id === 'federated' && segs[3] === 'runs') {
        if (!federationEnabled()) return send(res, 404, { error: 'not_found' });
        if (!isSkillOperator(bot)) {
          gw._audit({ type: 'skill_denied', bot: bot.name, skillId: null, action: 'fed_real_runs' });
          return send(res, 403, { error: 'operator_required' });
        }
        const ledger = getFedRunLedger();
        // /v2/skills/federated/runs/request → action at segs[4];
        // /v2/skills/federated/runs/:id/<action> → id at segs[4], action at segs[5].
        const seg4 = segs[4] || null;
        const action = seg4 === 'request' ? 'request' : (segs[5] || null);
        const runIdNum = action === 'request' ? null : Number(seg4);

        // ── request: EITHER operator (owner-side or runner-side) may open a
        // pending dual-approval row. The body names the skill + the runner
        // tenant; ownerTenant is derived from the SKILL record — the
        // caller cannot forge it.
        if (action === 'request') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); }
          catch { return send(res, 400, { error: 'invalid_json' }); }
          const skillId = body && body.skillId;
          const runnerTenantId = body && body.runnerTenant;
          const skill = skillId ? store.get(skillId) : null;
          if (!skill || !isFederated(skill)) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, skillId: skillId || null, reason: 'skill_not_federated' });
            return send(res, 404, { error: 'not_found' });
          }
          const ownerTenantId = skill.ownerTenant || 'main';
          if (!runnerTenantId || runnerTenantId === ownerTenantId) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, skillId: skill.id, reason: 'bad_runner_tenant' });
            return send(res, 400, { error: 'bad_request', detail: 'runnerTenant must differ from the owning tenant' });
          }
          // Approval-side scoping: the CALLING operator may open the request
          // only from its OWN side of the pair — the owner-tenant operator
          // (tenant matches ownerTenant) or the runner-tenant operator
          // (tenant matches runnerTenant). Anyone else learns nothing (404).
          if (tenant.id !== ownerTenantId && tenant.id !== runnerTenantId) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, skillId: skill.id, reason: 'not_a_party' });
            return send(res, 403, { error: 'operator_required' });
          }
          const rowId = ledger.requestRealRun({
            skillId: skill.id,
            ownerTenant: ownerTenantId,
            runnerTenant: runnerTenantId,
            runnerBot: bot.name,
          });
          gw._audit({ type: 'skill_fed_real_requested', runId: rowId, skillId: skill.id, ownerTenant: ownerTenantId, runnerTenant: runnerTenantId, by: bot.name });
          return send(res, 201, { runId: rowId, skillId: skill.id, ownerTenant: ownerTenantId, runnerTenant: runnerTenantId, status: 'pending' });
        }

        // ── approve-owner: the OWNING tenant's operator stamps the row.
        if (action === 'approve-owner') {
          const row = ledger.getPending(runIdNum);
          if (!row) return send(res, 404, { error: 'not_found' });
          if (tenant.id !== row.ownerTenant) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, runId: row.id, skillId: row.skillId, reason: 'not_owner_tenant' });
            return send(res, 403, { error: 'owner_tenant_required' });
          }
          const updated = ledger.approveByOwner(row.id, bot.name);
          gw._audit({ type: 'skill_fed_real_approved_owner', runId: row.id, skillId: row.skillId, by: bot.name, ownerTenant: row.ownerTenant, runnerTenant: row.runnerTenant });
          return send(res, 200, pendingProjection(updated));
        }

        // ── approve-runner: the RUNNING tenant's operator stamps the row.
        if (action === 'approve-runner') {
          const row = ledger.getPending(runIdNum);
          if (!row) return send(res, 404, { error: 'not_found' });
          if (tenant.id !== row.runnerTenant) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, runId: row.id, skillId: row.skillId, reason: 'not_runner_tenant' });
            return send(res, 403, { error: 'runner_tenant_required' });
          }
          const updated = ledger.approveByRunner(row.id, bot.name);
          gw._audit({ type: 'skill_fed_real_approved_runner', runId: row.id, skillId: row.skillId, by: bot.name, ownerTenant: row.ownerTenant, runnerTenant: row.runnerTenant });
          return send(res, 200, pendingProjection(updated));
        }

        // ── execute: ONLY when BOTH operators approved (isFullyApproved).
        // Executes the skill in the RUNNER-tenant context through the same
        // governed step loop, records the result hash, audits the run.
        // Any premature attempt → 403 + skill_fed_real_denied and NOTHING
        // executes.
        if (action === 'execute') {
          const row = ledger.getPending(runIdNum);
          if (!row) return send(res, 404, { error: 'not_found' });
          if (tenant.id !== row.runnerTenant) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, runId: row.id, skillId: row.skillId, reason: 'not_runner_tenant' });
            return send(res, 403, { error: 'runner_tenant_required' });
          }
          if (row.executedAt !== null) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, runId: row.id, skillId: row.skillId, reason: 'already_executed' });
            return send(res, 409, { error: 'already_executed' });
          }
          if (!ledger.isFullyApproved(row.id)) {
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, runId: row.id, skillId: row.skillId, reason: 'dual_approval_required' });
            return send(res, 403, { error: 'dual_approval_required' });
          }
          const skill = store.get(row.skillId);
          if (!skill || !isFederated(skill) || (skill.ownerTenant || 'main') !== row.ownerTenant) {
            // The skill moved under us (unfederated / edited / deleted) —
            // the approval no longer matches reality, fail closed.
            gw._audit({ type: 'skill_fed_real_denied', bot: bot.name, runId: row.id, skillId: row.skillId, reason: 'skill_no_longer_federated' });
            return send(res, 404, { error: 'not_found' });
          }

          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); }
          catch { return send(res, 400, { error: 'invalid_json' }); }
          const args = (body && body.args) || {};

          // Resolve every step's args up-front (same discipline as the
          // normal run path — any failure aborts before ANY step runs).
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
          // Audited with BOTH tags: the runner tenant's scope tag AND
          // federatedFrom on the same skill_run_started row.
          gw._audit({
            type: 'skill_run_started', skillId: skill.id, name: skill.name, bot: bot.name, steps: skill.steps.length, dry: false, runId: runSeq,
            ...tenantAuditTag(tenant), federatedFrom: row.ownerTenant,
          });

          const results = [];
          let status = 'completed';
          let completed = 0;
          for (const item of plan) {
            const { seq, tool, args: stepArgs, cls } = item;
            const verdict = decide({ tool, cls, bot });
            gw._audit({
              type: 'chat_action', kind: 'skill_step', skillId: skill.id, runId: runSeq,
              seq, bot: bot.name, tool, class: cls,
              decision: verdict.decision, reason: verdict.reason,
              argsLength: JSON.stringify(stepArgs).length,
            });
            if (verdict.decision === 'allow' && gw.dispatch) {
              try {
                const result = await gw.dispatch(bot.name, tool, stepArgs);
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
              // A destructive step still parks — in the RUNNER tenant's
              // scoped store, exactly as the normal cross-tenant path.
              // The dual approval authorized the run, not every step.
              const { approvalsStoreFor } = require('./09-approvals');
              const runningApprovals = approvalsStoreFor(gw, tenant);
              const approval = runningApprovals.request({ bot: { name: bot.name }, tool, args: stepArgs, reason: `skill ${skill.id} step ${seq}: ${verdict.reason}` });
              gw._audit({ type: 'approval_requested', approvalId: approval.id, bot: bot.name, tool, class: cls, federatedFrom: row.ownerTenant });
              results.push({ seq, tool, decision: 'needs_approval', approvalId: approval.id });
              status = 'parked';
              break;
            } else {
              results.push({ seq, tool, decision: verdict.decision, reason: verdict.reason });
              status = 'denied';
              break;
            }
          }

          // Record the result hash — the run happened, whatever the status.
          const rHash = resultHashOf(results);
          ledger.markExecuted(row.id, rHash);
          gw._audit({
            type: 'skill_fed_real_executed', runId: row.id, skillId: skill.id,
            ownerTenant: row.ownerTenant, runnerTenant: row.runnerTenant, bot: bot.name,
            runChainSeq: runSeq, status, completed, resultHash: rHash,
          });
          return send(res, 200, { runId: row.id, skillId: skill.id, runChainSeq: runSeq, status, completed, steps: results, resultHash: rHash });
        }

        return send(res, 404, { error: 'not_found' });
      }

      // ── POST /v2/skills/:id/run — governed execution (or ?dry=1 plan) ──
      if (req.method === 'POST' && isRun) {
        const skill = store.get(id);
        // FS-F4 visibility-aware lookup: a non-owner can find a SHARED skill
        // here (dry-run path below); a PRIVATE skill owned by someone else
        // stays 404 (anti-enum, byte-identical FS-F1 behavior). FS-G1: a
        // 'federated' skill is shared-like everywhere — and federation
        // adds CROSS-TENANT runs (below).
        if (!skill || !canViewSkill(skill, bot, access)) return send(res, 404, { error: 'not_found' });

        const dry = url.searchParams.get('dry') === '1';
        // FS-G1 bookkeeping: is this a CROSS-TENANT use of a federated
        // skill? Only when the env is ON, the skill is 'federated', and
        // the RUNNING tenant differs from the skill's ownerTenant.
        const crossTenantFederated = federationEnabled()
          && isFederated(skill)
          && tenant.id !== (skill.ownerTenant || 'main');

        // FS-H2: HONEST accounting + abuse limits for the cross-tenant
        // dry-run surface. Both caps are enforced BEFORE the dry-run
        // executes; the ledger records every cross-tenant dry run that
        // passes the caps. Env-off never reaches this branch (the
        // crossTenantFederated condition above is false), so a gateway
        // with TG_SKILLS_FEDERATION unset is byte-identical pre/post.
        if (crossTenantFederated && dry) {
          const ledger = getFedRunLedger();
          const perRunner = fedRunsPerHour();
          if (ledger.countByRunner(tenant.id, WINDOW_MS) >= perRunner) {
            return fedLimited(res, gw, tenant, skill.id, perRunner, 'per_runner_tenant');
          }
          const perSkill = fedRunsPerSkillHour();
          if (ledger.countBySkill(skill.id) >= perSkill) {
            return fedLimited(res, gw, tenant, skill.id, perSkill, 'per_skill');
          }
          ledger.record({
            skillId: skill.id,
            ownerTenant: skill.ownerTenant || 'main',
            runnerTenant: tenant.id,
            runnerBot: bot.name,
          });
        }

        // FS-F1 + FS-F4: self-service runs are dry-only — a non-owner may
        // dry-run its own or a SHARED skill, but the approval-gated live
        // run stays operator/author-only (FS-C1) regardless of visibility.
        // Refusal is audited. (Same-tenant federated skills follow the
        // exact FS-F4 rule.)
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
        // FS-G1: every cross-tenant run of a federated skill is audited
        // with BOTH tags on the SAME skill_run_started row:
        //   tenantAuditTag(running tenant)  AND  federatedFrom: <owner>.
        // Non-federated / same-tenant runs keep the untouched FS-C1 payload
        // (byte-identical; main stays untagged).
        gw._audit({
          type: 'skill_run_started', skillId: skill.id, name: skill.name, bot: bot.name, steps: skill.steps.length, dry, runId: runSeq,
          ...(crossTenantFederated ? { ...tenantAuditTag(tenant), federatedFrom: skill.ownerTenant || 'main' } : {}),
        });

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
            // FS-G1: approval rides the RUNNING tenant's store. The mount
            // matches /v2/skills only, so the running tenant's scoped store
            // is resolved here via the SAME WeakMap-cached factory the
            // FS-E1d approvals mount uses — tenant 'main' keeps the
            // singleton gw.approvals byte-identically.
            const { approvalsStoreFor } = require('./09-approvals');
            const runningApprovals = approvalsStoreFor(gw, tenant);
            const approval = runningApprovals.request({ bot: { name: bot.name }, tool, args, reason: `skill ${skill.id} step ${seq}: ${verdict.reason}` });
            const auditPayload = { type: 'approval_requested', approvalId: approval.id, bot: bot.name, tool, class: cls };
            if (crossTenantFederated) auditPayload.federatedFrom = skill.ownerTenant || 'main';
            gw._audit(auditPayload);
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
