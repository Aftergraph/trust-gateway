'use strict';
// v2 mount: GET /auth.js — the console auth shell (FS-A3).
//
// server.js's static whitelist predates the auth shell and is owned by
// parallel workstreams, so the file is served through the mount registry
// instead. Semantics mirror the whitelisted SPA assets exactly: public
// static client file (auth: 'none' — same as /app.js, /style.css etc.,
// which are served before any auth check), read from the SPA staticDir.
// No cache headers beyond the gateway defaults; content is a build-free
// source file.

const path = require('node:path');

module.exports = {
  name: 'authjs-static',
  method: 'GET',
  path: '/auth.js',
  auth: 'none',
  handle: async (gw, req, res /* , ctx */) => {
    const dir = gw.staticDir;
    if (!dir) return require('../server').send(res, 404, { error: 'not_found' });
    const file = path.join(dir, 'auth.js');
    if (!file.startsWith(path.resolve(dir) + path.sep)) {
      return require('../server').send(res, 400, { error: 'bad_path' });
    }
    try {
      // Delegate to the canonical static server: identical MIME, path guard
      // AND cache-control: no-cache — parity with the whitelisted SPA assets.
      // (A bespoke writeHead here previously bypassed #41's no-cache fix.)
      return gw._serveStatic(res, 'auth.js');
    } catch {
      require('../server').send(res, 404, { error: 'not_found' });
    }
  },
};
