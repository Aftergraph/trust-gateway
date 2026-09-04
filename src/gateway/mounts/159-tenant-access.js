'use strict';
// FS-A1 slice 3 — tenant-access mount (operator-only tenant listing for the
// console picker).

const { mountTenantAccess } = require('../tenant-access');

module.exports = function mount(gw) {
  mountTenantAccess(gw);
};