'use strict';
// RBAC surface for mounts/agents. canApprove lives in server.js (single
// source of truth); this module re-exports it so plugins import from here.
const { canApprove } = require('./server');
module.exports = { canApprove };