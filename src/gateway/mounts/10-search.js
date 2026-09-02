'use strict';
// v2 mount: GET /v2/search?q=<query> — audit log full-text search.
// Auth: query token (?token=...) because browser EventSource cannot set headers.

const { send } = require('../server');
const { searchChain } = require('../search');

module.exports = {
  name: 'search',
  method: 'GET',
  path: '/v2/search',
  auth: 'query',
  async handle(gw, req, res, ctx) {
    const q = ctx.url.searchParams.get('q') || '';
    const limit = Number(ctx.url.searchParams.get('limit') || 50);
    const result = searchChain(gw.chain, q, { limit });
    return send(res, 200, result);
  },
};
