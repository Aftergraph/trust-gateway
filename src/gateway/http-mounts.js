'use strict';
// v2 mount registry — conflict-free plugin surface for new HTTP endpoints.
// Each mount file in src/gateway/mounts/*.js exports:
//   { name, method, path (string or RegExp), auth: 'bearer'|'query'|'none',
//     handle: async (gw, req, res, ctx) => void }
// ctx = { url, params? } — handler owns the response via send().
// server.js consults these BEFORE its own routes (except when path === '*'
// with order:'after'). Static ordering: alphabetical by filename.

const fs = require('node:fs');
const path = require('node:path');

const MOUNTS_DIR = path.join(__dirname, 'mounts');

function loadMounts() {
  if (!fs.existsSync(MOUNTS_DIR)) return [];
  return fs
    .readdirSync(MOUNTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => {
      const m = require(path.join(MOUNTS_DIR, f));
      if (!m || !m.name || !m.method || !m.path || typeof m.handle !== 'function') {
        throw new Error(`mounts/${f}: must export {name, method, path, handle}`);
      }
      return { auth: 'bearer', ...m, file: f };
    });
}

function match(mount, method, pathname) {
  if (mount.method !== '*' && mount.method !== method) return null;
  if (typeof mount.path === 'string') {
    return mount.path === pathname ? {} : null;
  } // RegExp
  const m = pathname.match(mount.path);
  return m ? { matches: m } : null;
}

module.exports = { loadMounts, match };