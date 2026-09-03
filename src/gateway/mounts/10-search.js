'use strict';
// v2 mount: GET /v2/search?q=<query> — audit log full-text search.
// Auth: query token (?token=...) because browser EventSource cannot set headers.
//
// FS-E1 slice 2: tenant-scoped hits. The query token may carry a tenant
// prefix claim ('tnt_<id>_…'); bearer/query auth itself stays untouched.
// The main tenant sees the full chain byte-identically; any other tenant
// only sees audit entries tagged with ITS OWN tenant id (fail closed —
// untagged/other-tenant entries are invisible to it).

const { send } = require('../server');
const { searchChain } = require('../search');
const { resolveTenant } = require('../tenant-resolve');

module.exports = {
  name: 'search',
  method: 'GET',
  path: '/v2/search',
  auth: 'query',
  async handle(gw, req, res, ctx) {
    // Reconstruct the bearer header the query-auth runner already validated,
    // so the resolver can read the tenant prefix claim off the same token.
    const tk = ctx.url.searchParams.get('token') || '';
    const { tenant } = resolveTenant(
      { headers: { authorization: tk ? 'Bearer ' + tk : '' }, bot: ctx.bot },
      gw
    );
    if (!tenant) return send(res, 404, { error: 'not_found' });
    const q = ctx.url.searchParams.get('q') || '';
    const limit = Number(ctx.url.searchParams.get('limit') || 50);
    const result = searchChain(gw.chain, q, { limit });
    if (tenant.id !== 'main') {
      result.hits = result.hits.filter((h) => h && h.payload && h.payload.tenant === tenant.id);
      result.total = result.hits.length;
    }
    return send(res, 200, result);
  },
};
