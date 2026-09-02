'use strict';
// one AdapterRegistry per gateway instance (WeakMap), like providers-singleton.
// file path defaults under data/ (gitignored runtime dir).
const path = require('node:path');
const { AdapterRegistry } = require('./adapters');

const registries = new WeakMap();

function getAdapters(gw, { file } = {}) {
  let r = registries.get(gw);
  if (!r) {
    r = new AdapterRegistry({
      file: file ?? path.join(process.cwd(), 'data', 'adapters.json'),
    });
    registries.set(gw, r);
  }
  return r;
}

module.exports = { getAdapters };