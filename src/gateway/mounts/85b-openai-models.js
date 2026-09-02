'use strict';
// mount: GET /v1/models — OpenAI-compatible model list. auth: none (bearer
// checked in-handler → OpenAI-shaped 401). Lists every bot as 'tg/<bot>'
// plus the offline planner pseudo-model. No tokens anywhere in ids.
const { send } = require('../server');

const T_AUTH = 'authentication' + '_error';
function unauthorized(res, path, gw) {
  gw._audit({ type: 'auth_rejected', path });
  return send(res, 401, { error: { message: 'Invalid API key.', type: T_AUTH, code: 'invalid_api_key' } });
}

module.exports = {
  name: 'openai-models',
  method: 'GET',
  path: '/v1/models',
  auth: 'none',
  handle: async (gw, req, res) => {
    const bot = gw._auth(req);
    if (!bot) return unauthorized(res, '/v1/models', gw);
    const data = [];
    for (const name of Object.keys(gw.bots)) {
      data.push({ id: 'tg/' + name, object: 'model', owned_by: 'trust-gateway' });
    }
    data.push({ id: 'tg/atlas-chat-planner', object: 'model', owned_by: 'trust-gateway' });
    return send(res, 200, { object: 'list', data });
  },
};
