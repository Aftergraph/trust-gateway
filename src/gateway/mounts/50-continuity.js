'use strict';
// mount: /v2/goals + /v2/slash — W10 continuity HTTP surface.
// One mount file = one registered route (the loader contract), so this is a
// router: method '*', path matches the whole continuity surface, auth bearer,
// and handle dispatches on method+pathname. Step/loop endpoints run the
// policy gate inside GoalEngine (classify/decide against the goal owner's
// capabilities), so a caller can only advance steps the policy allows anyway.
const { send, readBody } = require('../server');
const { getEngine } = require('../continuity');

const PATH_RE = /^\/v2\/(?:goals(?:\/([^/]+)\/(step|resume))?|slash)$/;

function errStatus(e) {
  switch (e && e.code) {
    case 'bad_request': return 400;
    case 'unauthorized': return 401;
    case 'forbidden': return 403;
    case 'not_found': return 404;
    case 'conflict': return 409;
    default: return 400;
  }
}

async function readJson(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    send(res, 413, { error: 'body_too_large' });
    return null;
  }
  try { return JSON.parse(raw || '{}'); } catch {
    send(res, 400, { error: 'invalid_json' });
    return null;
  }
}

async function handle(gw, req, res, ctx) {
  const { url, bot } = ctx;
  const m = url.pathname.match(PATH_RE);
  const engine = getEngine(gw);

  // GET /v2/goals
  if (req.method === 'GET' && url.pathname === '/v2/goals') {
    const includeCleared = url.searchParams.get('all') === '1';
    return send(res, 200, { goals: engine.list({ includeCleared }).map((g) => engine.project(g)) });
  }

  // POST /v2/goals
  if (req.method === 'POST' && url.pathname === '/v2/goals') {
    const body = await readJson(req, res);
    if (body === null) return;
    try {
      const goal = engine.add({
        text: body.text,
        owner: body.owner || bot.name,
        steps: Array.isArray(body.steps) ? body.steps : [],
        bot,
      });
      return send(res, 201, { goal: engine.project(goal) });
    } catch (e) {
      return send(res, errStatus(e), { error: e.code || 'bad_request', message: e.message });
    }
  }

  // POST /v2/goals/:id/step | /v2/goals/:id/resume
  if (req.method === 'POST' && m[1]) {
    const id = m[1];
    try {
      if (m[2] === 'resume') engine.resume(id, bot);
      const out = await engine.takeStep(id);
      return send(res, 200, {
        done: out.done,
        resumed: m[2] === 'resume' ? true : undefined,
        stepIndex: out.stepIndex ?? null,
        decision: out.verdict ? out.verdict.decision : 'none',
        reason: out.verdict ? out.verdict.reason : undefined,
        approvalId: out.approvalId || null,
        goal: engine.project(out.goal),
      });
    } catch (e) {
      return send(res, errStatus(e), { error: e.code || 'bad_request', message: e.message });
    }
  }

  // POST /v2/slash {cmd}
  if (req.method === 'POST' && url.pathname === '/v2/slash') {
    const body = await readJson(req, res);
    if (body === null) return;
    try {
      const out = await engine.slash(bot, body.cmd);
      return send(res, 200, out);
    } catch (e) {
      return send(res, errStatus(e), { error: e.code || 'bad_request', message: e.message });
    }
  }

  send(res, 405, { error: 'method_not_allowed' });
}

module.exports = {
  name: 'v2-continuity',
  method: '*',
  path: /^\/v2\/(?:goals(?:\/[^/]+\/(?:step|resume))?|slash)$/,
  auth: 'bearer',
  handle,
};