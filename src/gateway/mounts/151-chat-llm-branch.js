'use strict';
// C4 mount: POST /v2/chat/llm/branch — forgren en LLM-session fra et givet punkt.
//
// Body: { session, at, name }
//   at:  heltal (0-baseret index i historikken, beskeden INDKLUDERES) eller 'latest'
//   name: ny sessions navn (1-64 tegn, samme regler som session)
//
// Response 200: { ok, source, branch, messages }
// Fail-closed: 400 ugyldig input / at uden for historikken, 404 tom kilde-session,
// 403 non-operator. Session-historik er process-tilstand — kun operator/owner må
// forgrene (kildesessionens indhold kan indeholde andre brugeres kontekst).
//
// Governance-neutral: branching ændrer kun hvilken kontekst fremtidige turns ser;
// alle turns fortsætter gennem SAMME propose-pipeline (classify/decide + approvals).
// Audit: chat_branch {source, branch, messages} — aldrig historikindhold.

const { send, readBody } = require('../server');
const { getBrain } = require('../llm-brain');

module.exports = {
  name: 'chat-llm-branch',
  method: 'POST',
  path: '/v2/chat/llm/branch',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot;
    const isOperator = bot && (bot.role === 'operator' || bot.role === 'owner'
      || (Array.isArray(bot.capabilities) && bot.capabilities.includes('*')));
    if (!isOperator) return send(res, 403, { error: 'operator_required' });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    await new Promise((r) => req.on('end', r));
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
    const { session, at, name } = body || {};
    if (typeof session !== 'string' || session.length < 1 || session.length > 64) return send(res, 400, { error: 'session_required' });
    if (typeof name !== 'string' || name.length < 1 || name.length > 64) return send(res, 400, { error: 'name_required' });
    if (name === session) return send(res, 400, { error: 'branch_name_conflicts_source' });

    const brain = getBrain(gw);
    const history = brain._history(session);
    if (!history.length) return send(res, 404, { error: 'session_not_found' });

    let cut;
    if (at === 'latest') {
      cut = history.length;
    } else {
      const n = Number(at);
      if (!Number.isInteger(n) || n < 0 || n >= history.length) {
        return send(res, 400, { error: 'invalid_at', valid: `0..${history.length - 1} or 'latest'` });
      }
      cut = n + 1; // beskeden på 'at' inkluderes
    }

    const branch = history.slice(0, cut).map((m) => ({ role: m.role, content: m.content }));
    brain.sessions.set(name, branch);

    gw._audit({ type: 'chat_branch', source: session, branch: name, messages: branch.length });
    send(res, 200, { ok: true, source: session, branch: name, messages: branch.length });
  },
};