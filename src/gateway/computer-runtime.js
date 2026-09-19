'use strict';
// Computer v1 — canonical provider/capability seam for governed host control.
//
// This module deliberately contains no Desktop Commander, Cua, Win32, or
// Playwright dependency. Providers register runtime adapters behind one
// Aftergraph contract; API projections expose metadata only, never adapter
// objects, endpoints, credentials, raw command args, or raw evidence bodies.

const PROVIDER_KINDS = Object.freeze([
  'desktop-commander',
  'cua-driver',
  'native',
  'playwright',
  'custom',
]);

const CAPABILITIES = Object.freeze([
  'computer.health.inspect',
  'computer.process.list',
  'computer.process.inspect',
  'computer.process.stop',
  'computer.files.read',
  'computer.files.write',
  'computer.shell.start',
  'computer.shell.send',
  'computer.shell.output',
  'computer.shell.stop',
  'computer.screen.capture',
  'computer.window.list',
  'computer.window.inspect',
  'computer.ui.inspect',
  'computer.input.click',
  'computer.input.type',
  'computer.input.scroll',
]);

const SEVERITIES = Object.freeze(['critical', 'warning', 'info']);
const DEPTHS = Object.freeze(['quick', 'standard', 'forensic']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return { ok: false, error: 'bad_manifest' };
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id))
    return { ok: false, error: 'bad_provider_id' };
  if (!PROVIDER_KINDS.includes(manifest.kind))
    return { ok: false, error: 'bad_provider_kind' };
  if (typeof manifest.version !== 'string' || manifest.version.length < 1 || manifest.version.length > 64)
    return { ok: false, error: 'bad_provider_version' };
  if (manifest.nodeId !== undefined && manifest.nodeId !== null
      && (typeof manifest.nodeId !== 'string' || !ID_RE.test(manifest.nodeId)))
    return { ok: false, error: 'bad_node_id' };
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length < 1)
    return { ok: false, error: 'bad_capabilities' };
  const caps = [...new Set(manifest.capabilities)];
  if (caps.some((c) => !CAPABILITIES.includes(c)))
    return { ok: false, error: 'unknown_capability' };
  return {
    ok: true,
    manifest: {
      id: manifest.id,
      kind: manifest.kind,
      version: manifest.version,
      nodeId: manifest.nodeId ?? null,
      capabilities: caps.sort(),
    },
  };
}

function projectProvider(entry) {
  return {
    id: entry.manifest.id,
    kind: entry.manifest.kind,
    version: entry.manifest.version,
    nodeId: entry.manifest.nodeId,
    capabilities: [...entry.manifest.capabilities],
  };
}

function normalizeFinding(provider, finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return null;
  if (typeof finding.type !== 'string' || !ID_RE.test(finding.type)) return null;
  if (!SEVERITIES.includes(finding.severity)) return null;
  if (typeof finding.summary !== 'string' || finding.summary.length < 1 || finding.summary.length > 500) return null;
  const refs = Array.isArray(finding.evidenceRefs)
    ? finding.evidenceRefs.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 256).slice(0, 32)
    : [];
  const recommendedCapability = finding.recommendedCapability ?? null;
  if (recommendedCapability !== null && !CAPABILITIES.includes(recommendedCapability)) return null;
  return {
    type: finding.type,
    severity: finding.severity,
    summary: finding.summary,
    evidenceRefs: refs,
    recommendedCapability,
    providerId: provider.manifest.id,
    nodeId: provider.manifest.nodeId,
  };
}

class ComputerProviderRegistry {
  constructor({ inspectionTimeoutMs = 5000 } = {}) {
    if (!Number.isFinite(inspectionTimeoutMs) || inspectionTimeoutMs < 1 || inspectionTimeoutMs > 60000)
      throw new Error('bad_inspection_timeout');
    this.providers = new Map();
    this.inspectionTimeoutMs = inspectionTimeoutMs;
  }

  register(manifest, adapter) {
    const v = validateManifest(manifest);
    if (!v.ok) return v;
    if (!adapter || typeof adapter !== 'object') return { ok: false, error: 'bad_adapter' };
    if (this.providers.has(v.manifest.id)) return { ok: false, error: 'provider_exists' };
    this.providers.set(v.manifest.id, { manifest: v.manifest, adapter });
    return { ok: true, provider: projectProvider(this.providers.get(v.manifest.id)) };
  }

  list() {
    return [...this.providers.values()].map(projectProvider)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    const p = this.providers.get(id);
    return p ? projectProvider(p) : null;
  }

  async inspectHealth({ depth = 'standard' } = {}) {
    if (!DEPTHS.includes(depth)) return { ok: false, error: 'bad_depth', allowedDepths: DEPTHS };
    const eligible = [...this.providers.values()]
      .filter((p) => p.manifest.capabilities.includes('computer.health.inspect'));

    if (eligible.length === 0) {
      return {
        ok: false,
        unavailable: true,
        partial: false,
        depth,
        providers: [],
        findings: [],
        errors: [],
      };
    }

    const findings = [];
    const errors = [];
    const attemptedProviders = [];
    const providers = [];
    for (const provider of eligible) {
      attemptedProviders.push(projectProvider(provider));
      if (typeof provider.adapter.inspectHealth !== 'function') {
        errors.push({ providerId: provider.manifest.id, error: 'adapter_missing_inspect_health' });
        continue;
      }
      try {
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('provider_timeout')), this.inspectionTimeoutMs);
        });
        const out = await Promise.race([
          provider.adapter.inspectHealth({ depth }),
          timeout,
        ]);
        if (!out || typeof out !== 'object' || Array.isArray(out) || !Array.isArray(out.findings)) {
          errors.push({ providerId: provider.manifest.id, error: 'provider_malformed_result' });
          continue;
        }
        providers.push(projectProvider(provider));
        for (const row of out.findings) {
          const normalized = normalizeFinding(provider, row);
          if (normalized) findings.push(normalized);
        }
      } catch (e) {
        errors.push({
          providerId: provider.manifest.id,
          error: String(e && e.message) === 'provider_timeout' ? 'provider_timeout' : 'provider_failed',
        });
      }
    }

    const rank = { critical: 0, warning: 1, info: 2 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity]
      || a.type.localeCompare(b.type)
      || a.providerId.localeCompare(b.providerId));

    return {
      ok: errors.length === 0 && providers.length > 0,
      unavailable: providers.length === 0,
      partial: errors.length > 0 && providers.length > 0,
      depth,
      providers,
      attemptedProviders,
      findings,
      errors,
    };
  }
}

const registries = new WeakMap();
function getComputerProviderRegistry(gw) {
  let registry = registries.get(gw);
  if (!registry) {
    registry = new ComputerProviderRegistry();
    registries.set(gw, registry);
  }
  return registry;
}

module.exports = {
  PROVIDER_KINDS,
  CAPABILITIES,
  SEVERITIES,
  DEPTHS,
  validateManifest,
  normalizeFinding,
  ComputerProviderRegistry,
  getComputerProviderRegistry,
};
