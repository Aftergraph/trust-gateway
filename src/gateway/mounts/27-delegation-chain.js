'use strict';
// P2 mount: GET /v2/rooms/:id/chain — delegation-chain tree for a room.
//
// Function-style mount: module.exports = function mount(gw) { ... }
// Registers the route + hooks the room store to record A2A delegation edges.
//
//   GET /v2/rooms/:id/chain → { tree: {msgId, kind, from, children} | null }
//
// ponytail: singleton DelegationChain. Upgrade to persistent store if
// multi-node deployment needs a shared chain.

const { DelegationChain } = require('../delegation-chain');

/** @type {DelegationChain|null} */
let _chain = null;

function getChain() {
  if (!_chain) _chain = new DelegationChain();
  return _chain;
}

/**
 * Hook a room store's deliver() to record A2A delegation edges.
 * Exported for direct test access.
 * @param {import('../groups').RoomStore} store
 * @param {DelegationChain} [chain] — defaults to the singleton
 */
function hookRoomStore(store, chain) {
  chain = chain || getChain();
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
          // Record as root node (no delegation parent)
          chain.record(null, msg.id, { kind: opts.kind || 'message', from: opts.from }, room.id);
        }
      }
    }
    return result;
  };
}

module.exports = function mount(gw) {
  const chain = getChain();

  // Hook the room store
  const { getRoomStore } = require('../groups');
  const store = getRoomStore(gw);
  hookRoomStore(store, chain);

  // Register the route
  gw.router.get('/v2/rooms/:id/chain', async (req, res) => {
    const roomId = req.params?.id;
    const room = store.get(roomId);
    if (!room) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'room_not_found' }));
    }
    const tree = chain.tree(roomId);
    res.statusCode = 200;
    res.end(JSON.stringify({ tree }));
  });
};

module.exports.getChain = getChain;
module.exports.hookRoomStore = hookRoomStore;
