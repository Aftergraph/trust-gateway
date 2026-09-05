'use strict';
// P2 mount: GET /v2/rooms/:id/chain — delegation-chain tree for a room.
//
// Function-style mount: module.exports = function mount(gw) { ... }
// Registers the route + hooks the room store to record A2A delegation edges.
//
//   GET /v2/rooms/:id/chain → { tree: {msgId, kind, from, children} | null }
//
// Gateway-scoped chains prevent one gateway/tenant graph from leaking into
// another gateway instance. Persistence remains a separate future slice.

const { DelegationChain, DurableDelegationChain } = require('../delegation-chain');
const { resolveTenant } = require('../tenant-resolve');

/** @type {WeakMap<object, Map<string, DelegationChain>>} */
const chains = new WeakMap();

function getChain(gw, tenantId = null) {
  if (!gw || (typeof gw !== 'object' && typeof gw !== 'function')) {
    throw new Error('delegation-chain: gateway required');
  }
  let byTenant = chains.get(gw);
  if (!byTenant) {
    byTenant = new Map();
    chains.set(gw, byTenant);
  }
  const key = tenantId || '__default__';
  let chain = byTenant.get(key);
  if (!chain) {
    let file = null;
    if (tenantId) {
      const { delegationChainFile } = require('../tenant-scope');
      file = delegationChainFile(null, gw, tenantId);
    } else if (gw.delegationChainFile) {
      file = gw.delegationChainFile;
    } else if (gw.delegationChainTenantId) {
      const { delegationChainFile } = require('../tenant-scope');
      file = delegationChainFile(null, gw, gw.delegationChainTenantId);
    }
    chain = file ? new DurableDelegationChain({ file }) : new DelegationChain();
    byTenant.set(key, chain);
  }
  return chain;
}

/**
 * Hook a room store's deliver() to record A2A delegation edges.
 * @param {import('../groups').RoomStore} store
 * @param {DelegationChain} chain
 */
function hookRoomStore(store, chainOrResolver) {
  if (!store || !chainOrResolver) throw new Error('delegation-chain: store and chain required');
  const origDeliver = store.deliver.bind(store);
  store.deliver = async function (roomId, opts) {
    const result = await origDeliver(roomId, opts);
    if (result.ok) {
      const room = typeof roomId === 'string' ? store.rooms.get(roomId) : roomId;
      const chain = typeof chainOrResolver === 'function' ? chainOrResolver(opts.tenantId) : chainOrResolver;
      const msg = result.message || (room && room.messages[room.messages.length - 1]);
      const messageId = msg && msg.id;
      if (chain && room && messageId) {
        if (Array.isArray(opts.chain) && opts.chain.length > 0) {
          for (const hop of opts.chain) {
            chain.record(hop.parentMsgId || null, messageId,
              { kind: hop.kind || opts.kind || 'message', from: opts.from }, room.id);
          }
        } else {
          chain.record(null, messageId, { kind: opts.kind || 'message', from: opts.from }, room.id);
        }
      }
    }
    return result;
  };
}

module.exports = function mount(gw) {
  const { getRoomStore } = require('../groups');
  const store = getRoomStore(gw);
  const tenantFor = (id) => getChain(gw, id);
  hookRoomStore(store, tenantFor);

  gw.router.get('/v2/rooms/:id/chain', async (req, res, ctx) => {
    const roomId = ctx?.params?.[1] || req.params?.id;
    const room = store.get(roomId);
    if (!room) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'room_not_found' }));
    }
    const { tenant } = ctx?.tenant ? { tenant: ctx.tenant } : resolveTenant(req, gw);
    if (!tenant) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'room_not_found' }));
    }
    const chain = getChain(gw, tenant.id);
    res.statusCode = 200;
    res.end(JSON.stringify({ tree: chain.tree(roomId) }));
  });
};

module.exports.getChain = getChain;
module.exports.hookRoomStore = hookRoomStore;
