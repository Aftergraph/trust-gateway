'use strict';
// FS-E1 slice 1 — MINIMAL tenant wiring. server.js and bin/gateway.js stay
// untouched: mounts run before built-in routes, so this shadows the v1
// /healthz and returns a SUPERSET of the old body ({ok, chain} + tenant),
// proving the resolver runs without rewiring any other mount (slices 2-3
// own that). Unknown/disabled tenant on any route → 404, never 403
// (anti-enumeration).

const { send } = require('../server');
const { resolveTenant } = require('../tenant-resolve');
const { enforceQuotas } = require('../tenant-scope');
const { execFileSync } = require('node:child_process');

// S5 reality-readback: expose the exact git SHA this process was deployed
// from, so an external probe can bind the RUNNING service to a reproducible
// commit without traversing the (root-owned, ACL-blocked) checkout. Additive
// superset of the v1 body — never removes ok/chain/tenant. Env override wins
// so CI/build can pin it; otherwise resolve HEAD from the on-disk repo.
let _deployedCommit;
function deployedCommit() {
  if (_deployedCommit !== undefined) return _deployedCommit;
  // Exact-SHA only (STEWARD: every verdict binds to an exact commit SHA) —
  // abbreviated hashes are rejected so a readback can never be ambiguous.
  const env = process.env.GATEWAY_DEPLOYED_COMMIT || process.env.SOURCE_VERSION || '';
  if (/^[0-9a-f]{40}$/.test(env)) { _deployedCommit = env; return _deployedCommit; }
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    _deployedCommit = /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { _deployedCommit = null; }
  return _deployedCommit;
}

module.exports = {
  name: 'tenant-healthz',
  method: 'GET',
  path: '/healthz',
  auth: 'none', // healthz stays unauthenticated (body is non-secret)
  handle: async (gw, req, res, ctx) => {
    // auth:'none' mounts get ctx.bot=null — resolve operator-ness ourselves
    // from the bearer header (read-only check, never an auth decision).
    req.bot = ctx.bot || gw._auth ? (ctx.bot || (gw._auth ? gw._auth(req) : null)) : null;
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return send(res, 404, { error: 'not_found' });
    if (enforceQuotas(gw, tenant, res)) return; // FS-I3: fail-closed quotas
    return send(res, 200, { ok: true, chain: gw.chain.verify(), tenant: tenant.id, deployed_commit: deployedCommit() });
  },
};
