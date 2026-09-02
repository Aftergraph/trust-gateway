'use strict';
// one ProviderRegistry per gateway instance (WeakMap), like chat-singleton.
// file path defaults under data/ (gitignored runtime dir).
const path = require('node:path');
const { ProviderRegistry } = require('./providers');

const registries = new WeakMap();

function getRegistry(gw, { file } = {}) {
  let r = registries.get(gw);
  if (!r) {
    r = new ProviderRegistry({
      file: file ?? path.join(process.cwd(), 'data', 'providers.json'),
    });
    registries.set(gw, r);
  }
  return r;
}

module.exports = { getRegistry };