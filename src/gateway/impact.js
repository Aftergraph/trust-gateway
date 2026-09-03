'use strict';
// Trust Gateway — deterministic, locally-computed impact analysis.
// NOT an LLM. Blast radius is a small switch on the tool namespace;
// rollback is a templated string per tool family. Confidence is
// 'computed' for known namespaces and 'missing' for unknown tools.

const { classify } = require('./policy');

// Known tool namespaces — anything outside these is "unknown".
const KNOWN_NAMESPACES = new Set([
  'fs', 'shell', 'web', 'db', 'http', 'deploy', 'payment',
  'harness', 'adapter', 'secret', 'credential',
]);

// Map base namespace → blast radius (deterministic switch).
const BLAST_RADIUS = {
  fs: 'within_run',
  shell: 'within_bot',
  web: 'within_bot',
  db: 'cross_bot',
  http: 'external',
  deploy: 'external',
  payment: 'external',
  harness: 'within_bot',
  adapter: 'within_bot',
  secret: 'within_bot',
  credential: 'within_bot',
};

// Extract the base namespace from a tool string.
// "fs.write" → "fs",  "fs.delete:old-logs" → "fs",
// "web.fetch:https://x" → "web", "adapter_probe" → "adapter".
function getBaseNamespace(tool) {
  if (typeof tool !== 'string' || tool.length === 0) return '';
  // Strip the colon suffix (e.g. "fs.delete:old-logs" → "fs.delete").
  const colonIdx = tool.indexOf(':');
  const prefix = colonIdx >= 0 ? tool.slice(0, colonIdx) : tool;
  // Extract the first segment before '.' or '_'.
  const dotIdx = prefix.indexOf('.');
  const underIdx = prefix.indexOf('_');
  const sep = (dotIdx >= 0 && underIdx >= 0)
    ? Math.min(dotIdx, underIdx)
    : (dotIdx >= 0 ? dotIdx : underIdx);
  return sep >= 0 ? prefix.slice(0, sep) : prefix;
}

// Derive affected objects from the tool + args.
function getAffectedObjects(tool, args) {
  const objs = [];
  const ns = getBaseNamespace(tool);

  if (ns === 'fs') {
    // fs.read:<path> or fs.write with args.path
    const path = resolvePath(args);
    if (path) objs.push(path);
  } else if (ns === 'web') {
    // web.fetch:<url> or web.fetch with args.url → hostname
    const url = resolveUrl(args);
    if (url) objs.push(url);
  }

  // Fallback: if args is a string that looks like a path, include it.
  if (objs.length === 0 && typeof args === 'string' && args.length > 0) {
    objs.push(args);
  }

  return objs;
}

function resolvePath(args) {
  if (!args) return null;
  if (typeof args === 'object' && args.path) return args.path;
  if (typeof args === 'object' && args.file) return args.file;
  return null;
}

function resolveUrl(args) {
  if (!args) return null;
  if (typeof args === 'object' && args.url) {
    try {
      const u = new URL(args.url);
      return u.hostname;
    } catch {
      return null;
    }
  }
  return null;
}

// Templated rollback plan per tool family. Never fabricate steps.
function getRollbackPlan(tool, args) {
  const ns = getBaseNamespace(tool);

  if (ns === 'fs' && tool !== 'fs.read') {
    // fs.write, fs.delete, fs.mkdir → reversible for writes via path
    const path = resolvePath(args);
    if (path) return `delete the file at ${path}`;
    return 'no automated rollback — reverse manually';
  }
  if (ns === 'fs' && tool === 'fs.read') {
    return 'no automated rollback';
  }
  if (ns === 'shell') {
    return 'no automated rollback — reverse manually';
  }
  if (ns === 'http' && tool === 'http.post') {
    return 'no automated rollback';
  }
  if (ns === 'web') {
    return 'no automated rollback';
  }
  if (ns === 'db') {
    return 'no automated rollback — reverse manually';
  }
  if (ns === 'deploy') {
    return 'no automated rollback';
  }
  if (ns === 'harness') {
    return 'no automated rollback — reverse manually';
  }
  if (ns === 'payment') {
    return 'no automated rollback';
  }

  // Unknown namespace — must NOT fabricate.
  return 'pending backend support';
}

/**
 * computeImpact({tool, args, gw}) → {affectedObjects, blastRadius, risk,
 * rollbackPlan, evidenceChainRefs?, confidence}
 *
 * Deterministic: no randomness, no LLM. For unknown tools, confidence is
 * 'missing' and the rollback plan says 'pending backend support' — never
 * a fabricated rollback.
 */
function computeImpact({ tool, args, gw }) {
  const ns = getBaseNamespace(tool);

  // Unknown tool → fail-closed stance, confidence 'missing'.
  if (!KNOWN_NAMESPACES.has(ns)) {
    return {
      affectedObjects: [],
      blastRadius: 'external',
      risk: 'destructive',
      rollbackPlan: 'pending backend support',
      confidence: 'missing',
    };
  }

  const blastRadius = BLAST_RADIUS[ns] || 'within_bot';
  const risk = classify(tool);
  const affectedObjects = getAffectedObjects(tool, args);
  const rollbackPlan = getRollbackPlan(tool, args);

  // evidenceChainRefs: scan live chain entries that reference this approval.
  const evidenceChainRefs = [];
  if (gw && gw.chain && Array.isArray(gw.chain.entries)) {
    for (const entry of gw.chain.entries) {
      const p = entry.payload || {};
      if (p.approvalId) {
        // We don't have the approval id here; the mount handler recomputes
        // with the actual approval id. This stays empty at creation time.
      }
    }
  }

  return {
    affectedObjects,
    blastRadius,
    risk,
    rollbackPlan,
    confidence: 'computed',
    evidenceChainRefs,
  };
}

module.exports = { computeImpact, getBaseNamespace, KNOWN_NAMESPACES, BLAST_RADIUS };
