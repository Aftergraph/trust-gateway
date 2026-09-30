'use strict';

const fs = require('node:fs');

const HEX64 = /^[a-f0-9]{64}$/i;

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return 'null';
}

function sha256Hex(value) {
  return require('node:crypto').createHash('sha256').update(value, 'utf8').digest('hex');
}

function verifyAggregateSnapshot(snapshot, { now = Date.now(), maxAgeMs = 90_000 } = {}) {
  const reasons = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { valid: false, reasons: ['snapshot_required'] };
  if (snapshot.schemaVersion !== 'aftergraph.tool-fabric-snapshot/v1') reasons.push('unsupported_schema');
  if (snapshot.authorityGranted !== false) reasons.push('authority_claim_forbidden');
  if (snapshot.credentialsExposed !== false) reasons.push('credential_exposure_forbidden');
  if (!Array.isArray(snapshot.tools)) reasons.push('tools_array_required');
  if (!snapshot.federation || snapshot.federation.authorityGranted !== false) reasons.push('federation_status_required');
  if (snapshot.federation && snapshot.federation.healthy !== true) reasons.push('federation_unhealthy');
  if (!HEX64.test(String(snapshot.snapshotDigest || ''))) reasons.push('snapshot_digest_invalid');

  const generatedAt = Date.parse(snapshot.generatedAt || '');
  if (!Number.isFinite(generatedAt)) reasons.push('generated_at_invalid');
  else {
    const age = Math.max(0, now - generatedAt);
    if (age > maxAgeMs) reasons.push('snapshot_stale');
  }

  if (reasons.length === 0) {
    const { snapshotDigest, ...payload } = snapshot;
    const expected = sha256Hex(canonicalJson(payload));
    if (expected !== snapshotDigest) reasons.push('snapshot_digest_mismatch');
  }

  return { valid: reasons.length === 0, reasons };
}

function validatePolicyMap(policyMap) {
  if (!policyMap || typeof policyMap !== 'object') return ['policy_map_required'];
  const errors = [];
  if (policyMap.schemaVersion !== 'aftergraph.tool-policy-map/v1') errors.push('unsupported_policy_map_schema');
  if (!Array.isArray(policyMap.entries)) errors.push('policy_map_entries_required');
  if (Array.isArray(policyMap.entries)) {
    const seen = new Set();
    for (const row of policyMap.entries) {
      if (!row || !String(row.toolId || '').trim() || !String(row.capability || '').trim() || !String(row.policyTool || '').trim()) {
        errors.push('policy_map_entry_invalid');
        continue;
      }
      const key = row.toolId + '\u0000' + row.capability;
      if (seen.has(key)) errors.push('policy_map_entry_duplicate');
      seen.add(key);
    }
  }
  return [...new Set(errors)];
}

class FileToolFabricResolver {
  constructor({ snapshotPath, policyMapPath, maxAgeMs = 90_000, now = () => Date.now() } = {}) {
    if (!String(snapshotPath || '').trim()) throw new Error('tool_fabric_snapshot_path_required');
    if (!String(policyMapPath || '').trim()) throw new Error('tool_policy_map_path_required');
    this.snapshotPath = snapshotPath;
    this.policyMapPath = policyMapPath;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  async resolve({ toolId, capability, provenanceDigest } = {}) {
    const snapshot = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    const verification = verifyAggregateSnapshot(snapshot, { now: this.now(), maxAgeMs: this.maxAgeMs });
    if (!verification.valid) {
      const error = new Error('tool_fabric_snapshot_invalid:' + verification.reasons.join(','));
      error.code = 'tool_fabric_snapshot_invalid';
      throw error;
    }

    const policyMap = JSON.parse(fs.readFileSync(this.policyMapPath, 'utf8'));
    const policyErrors = validatePolicyMap(policyMap);
    if (policyErrors.length) {
      const error = new Error('tool_policy_map_invalid:' + policyErrors.join(','));
      error.code = 'tool_policy_map_invalid';
      throw error;
    }

    const tool = snapshot.tools.find((item) => item && item.id === toolId);
    if (!tool) return null;
    if (!Array.isArray(tool.capabilities) || !tool.capabilities.includes(capability)) return null;
    if (tool.provenance?.digest !== provenanceDigest) return null;

    const mapping = policyMap.entries.find((entry) => entry.toolId === toolId && entry.capability === capability);
    if (!mapping) return { tool, policyTool: null };
    return { tool, policyTool: mapping.policyTool };
  }
}

function createFileToolFabricResolverFromEnv(env = process.env) {
  const snapshotPath = env.AFTERGRAPH_TOOL_FABRIC_SNAPSHOT;
  const policyMapPath = env.AFTERGRAPH_TOOL_POLICY_MAP;
  if (!snapshotPath || !policyMapPath) return null;
  const parsed = Number(env.AFTERGRAPH_TOOL_FABRIC_MAX_AGE_MS || 90_000);
  const maxAgeMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
  return new FileToolFabricResolver({ snapshotPath, policyMapPath, maxAgeMs });
}

module.exports = {
  canonicalJson,
  verifyAggregateSnapshot,
  validatePolicyMap,
  FileToolFabricResolver,
  createFileToolFabricResolverFromEnv,
};
