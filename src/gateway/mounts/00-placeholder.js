'use strict';
// Placeholder mount file. Real v2 mounts (events, chat, stats, search) are added
// as sibling files in src/gateway/mounts/ — see docs/v2/PERSISTENCE-DASHBOARD-CHAT.md.
module.exports = { name: 'placeholder', method: 'GET', path: '/v2/ping', auth: 'none', handle: async (gw, req, res) => {
  const { send } = require('../server');
  send(res, 200, { ok: true, v2: true });
} };