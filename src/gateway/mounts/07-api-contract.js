'use strict';
// P2 mount: /v2/api-contract — developer platform v0.
//   GET /v2/api-contract            OpenAPI 3.1 contract generated from live mounts
//   GET /v2/api-contract/sdk        SDK surface summary (operations the client can call)
const { send } = require('../server');
const { buildApiContract: buildContract, sdkSurface } = require('../api-contract.js');

module.exports = {
  name: 'v2-api-contract',
  method: 'GET',
  path: /^\/v2\/api-contract(\/(sdk))?$/,
  auth: 'none', // contract + SDK surface are public developer docs (no secrets in them)
  handle: async (gw, req, res, ctx) => {
    const mounts = (gw.mounts || []).map((m) => ({ name: m.name, method: m.method, path: m.path, auth: m.auth }));
    const contract = buildContract(mounts, { version: process.env.TG_API_VERSION || '0.4.0' });
    if (ctx.url.pathname.endsWith('/sdk')) {
      return send(res, 200, {
        contract_version: contract.info.version,
        contract_hash: contract.info['x-contract-hash'],
        surface: sdkSurface(contract),
      });
    }
    return send(res, 200, contract);
  },
};