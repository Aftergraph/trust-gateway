'use strict';
// Trust Gateway — fail-closed action policy.
// Philosophy: an unknown tool is a dangerous tool. Classify first,
// decide second, audit always (the server writes the audit entry).

const CLASSIFICATIONS = [
  // reads
  { match: ['fs.read:*', 'fs.read', 'web.get', 'web.get:*', 'web.search', 'web.search:*', 'web.fetch', 'web.fetch:*', 'web.extract', 'web.extract:*', 'db.read:*', 'adapter_probe:*', 'adapter_test:*'], cls: 'read' },
  // writes
  { match: ['fs.write:*', 'fs.write', 'fs.mkdir', 'db.write:*', 'http.post'], cls: 'write' },
  // destructive
  {
    match: ['shell.run', 'shell.run:*', 'fs.delete:*', 'fs.delete', 'db.drop:*', 'deploy:*', 'payment:*', 'harness.run:*', 'harness.build:*'],
    cls: 'destructive',
  },
  // secrets
  { match: ['secret.read:*', 'secret.read', 'credential.use:*'], cls: 'secret' },
];

function classify(tool) {
  if (typeof tool !== 'string' || tool.length === 0) return 'destructive';
  for (const rule of CLASSIFICATIONS) {
    for (const pattern of rule.match) {
      if (pattern === tool) return rule.cls;
      if (pattern.endsWith(':*') && tool.startsWith(pattern.slice(0, -1))) return rule.cls;
    }
  }
  return 'destructive'; // fail closed
}

// Decide WITHOUT executing. Returns { decision, reason } where decision ∈
// 'allow' | 'needs_approval' | 'deny'. The caller is responsible for the
// audit entry (write-ahead) and for dispatching only on 'allow'.
function decide({ tool, cls = classify(tool), bot }) {
  const caps = (bot && Array.isArray(bot.capabilities)) ? bot.capabilities : [];
  const hasCap = caps.includes('*') || caps.includes(tool) || caps.some((c) => c.endsWith(':*') && tool.startsWith(c.slice(0, -1)));

  if (cls === 'read') {
    return { decision: 'allow', reason: 'read actions are pre-approved' };
  }
  if (cls === 'write') {
    return hasCap
      ? { decision: 'allow', reason: `capability ${tool} granted` }
      : { decision: 'needs_approval', reason: `no capability ${tool}` };
  }
  if (cls === 'destructive') {
    // Even with capability, destructive needs a human. Always.
    return { decision: 'needs_approval', reason: 'destructive actions always require approval' };
  }
  if (cls === 'secret') {
    return hasCap
      ? { decision: 'needs_approval', reason: 'secret access requires explicit approval' }
      : { decision: 'deny', reason: 'secret access requires approval AND capability' };
  }
  return { decision: 'deny', reason: `unclassified class ${cls}` };
}

// Role-based default capabilities (used when provisioning a bot).
const ROLE_CAPABILITIES = {
  worker: ['fs.read', 'fs.write:*', 'web.get', 'web.search'],
  analyst: ['fs.read', 'web.get', 'web.search', 'db.read:*'],
  operator: ['fs.read', 'fs.write:*', 'shell.run', 'web.get'], // still gated: shell = destructive
  auditor: ['fs.read', 'audit.read'],
};

function capabilitiesFor(role) {
  return ROLE_CAPABILITIES[role] ? [...ROLE_CAPABILITIES[role]] : ['fs.read', 'web.get'];
}

module.exports = { classify, decide, capabilitiesFor, ROLE_CAPABILITIES };