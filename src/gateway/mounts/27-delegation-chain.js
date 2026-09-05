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

const { DelegationChain } = require('../delegation-chain');

/** @type {WeakMap<object, DelegationChain>} */
const chains = new WeakMap();

function getChain(gw) {
  if (!gw || (typeof gw !== 'object' && typeof gw !== 'function')) {
    throw new Error('delegation-chain: gateway required');
  }
  let chain = chains.get(gw);
  if (!chain) {
    chain = new DelegationChain();
    chains.set(gw, chain);
  }
  return chain;
}

/**
 * Hook a room store's deliver() to record A2A delegation edges.
 * @param {import('../groups').RoomStore} store
 * @param {DelegationChain} chain
 */
function hookRoomStore(store, chain) {
  if (!store || !chain) throw new Error('delegation-chain: store and chain required');
  const origDeliver = store.deliver.bind(store);
  store.deliver = async function (roomId, opts) {
    const result = await origDeliver(roomId, opts);
    if (result.ok) {
      const room = typeof roomId === 'string' ? store.rooms.get(roomId) : roomId;
      if (room && room.messages.length > 0) {
        const msg = room.messages[room.messages.length - 1];
        if (Array.isArray(opts.chain) && opts.chain.length > 0) {
          for (const hop of opts.chain) {
            chain.record(
              hop.parentMsgId || null,
              msg.id || String(room.messages.length - 1),
              { kind: hop.kind || opts.kind || 'message', from: opts.from },
              room.id
            );
          }
        } else {
          chain.record(null, msg.id, { kind: opts.kind || 'message', from: opts.from }, room.id);
        }
      }
    }
    return result;
  };
}

module.exports = function mount(gw) {
  const chain = getChain(gw);
  const { getRoomStore } = require('../groups');
  const store = getRoomStore(gw);
  hookRoomStore(store, chain);

  gw.router.get('/v2/rooms/:id/chain', async (req, res) => {
    const roomId = req.params?.id;
    const room = store.get(roomId);
    if (!room) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'room_not_found' }));
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ tree: chain.tree(roomId) }));
  });
};

module.exports.getChain = getChain;
module.exports.hookRoomStore = hookRoomStore;
