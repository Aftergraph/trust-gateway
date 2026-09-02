'use strict';
// v2 mount: GET /v2/events — Server-Sent Events feed of audit entries.
//
// Auth mode is 'query' because browser EventSource cannot set custom
// request headers. The mount runner in server.js has already verified
// ?token=<bearer> against the gateway's bot table before this handler
// runs, so ctx.bot is the authenticated bot. We delegate straight to
// the shared EventHub singleton, which will write SSE headers, push the
// initial `retry:` and `hello` frames, and stream `event: audit` frames
// for every sealed entry until the client disconnects.
//
// NOTE on plain-`http` testing: works fine — http.get keeps the response
// streaming and Node's `res.on('data', ...)` is how the test consumes it.

const { getHub } = require('../events');

module.exports = {
  name: 'v2-events',
  method: 'GET',
  path: '/v2/events',
  auth: 'query',
  handle: async (gw, req, res, ctx) => {
    // ctx.bot is the authenticated caller (validated by the mount runner).
    // We don't currently authorize per-stream, but recording it in the
    // hello frame (and future audit) is a future hook.
    getHub(gw).addClient(res);
    // addClient attaches 'close' / 'error' listeners; nothing to await.
  },
};
