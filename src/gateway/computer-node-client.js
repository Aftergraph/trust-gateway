'use strict';
// Optional bridge from Trust Gateway to an external Aftergraph Computer Node.
// Secrets stay in process env / closure and are never registered or projected.

const connecting = new WeakMap();
const ready = new WeakSet();

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function config() {
  const url = process.env.TG_COMPUTER_NODE_URL || '';
  const token = process.env.TG_COMPUTER_NODE_TOKEN || '';
  const authorityToken = process.env.TG_COMPUTER_NODE_AUTHORITY_TOKEN || '';
  if (!url && !token) return { configured: false };
  if (!url || !token) return { configured: true, ok: false, error: 'incomplete_configuration' };
  let parsed;
  try { parsed = new URL(url); } catch { return { configured: true, ok: false, error: 'bad_url' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    return { configured: true, ok: false, error: 'bad_url' };
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname))
    return { configured: true, ok: false, error: 'tls_required' };
  return {
    configured: true,
    ok: true,
    url: parsed.toString().replace(/\/$/, ''),
    token,
    authorityToken,
  };
}

async function jsonFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`computer_node_http_${res.status}`);
  return res.json();
}

function createInspectionFetcher(baseUrl, token) {
  const inFlight = new Map();
  return function fetchInspection(depth) {
    if (inFlight.has(depth)) return inFlight.get(depth);
    const promise = jsonFetch(`${baseUrl}/v1/inspect`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'health', depth }),
    });
    inFlight.set(depth, promise);
    promise.finally(() => {
      setImmediate(() => {
        if (inFlight.get(depth) === promise) inFlight.delete(depth);
      });
    }).catch(() => {});
    return promise;
  };
}

function createActionInvoker(baseUrl, token, authorityToken) {
  return async function invokeAction(request, { effectful = false } = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('bad_action_request');
    const headers = { 'content-type': 'application/json' };
    if (effectful) {
      if (!authorityToken) throw new Error('effect_authority_unconfigured');
      headers['x-aftergraph-authority'] = authorityToken;
    }
    return jsonFetch(`${baseUrl}/v1/action`, token, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
  };
}

async function invokeConfiguredComputerNode(request, options = {}) {
  const cfg = config();
  if (!cfg.configured) throw new Error('computer_node_unconfigured');
  if (!cfg.ok) throw new Error(cfg.error || 'computer_node_unavailable');
  const invoke = createActionInvoker(cfg.url, cfg.token, cfg.authorityToken);
  return invoke(request, options);
}

function providerAdapter(fetchInspection, providerId) {
  return {
    async inspectHealth({ depth }) {
      const out = await fetchInspection(depth);
      if (!out || typeof out !== 'object' || Array.isArray(out)
          || !Array.isArray(out.providers)
          || !Array.isArray(out.findings)
          || !Array.isArray(out.errors))
        throw new Error('node_malformed_inspection');
      const providerError = out.errors.find((e) => e && e.providerId === providerId);
      if (providerError) throw new Error('node_provider_failed');
      if (!out.providers.includes(providerId)) throw new Error('node_provider_not_successful');
      const findings = out.findings
        .filter((finding) => finding && finding.providerId === providerId)
        .map(({ providerId: _providerId, ...finding }) => finding);
      return { findings };
    },
  };
}

async function connect(gw, registry) {
  const cfg = config();
  if (!cfg.configured) return { configured: false, ok: true };
  if (!cfg.ok) return cfg;

  const manifest = await jsonFetch(`${cfg.url}/v1/manifest`, cfg.token);
  if (!manifest || typeof manifest.nodeId !== 'string' || !Array.isArray(manifest.providers))
    return { configured: true, ok: false, error: 'bad_manifest' };

  const fetchInspection = createInspectionFetcher(cfg.url, cfg.token);
  for (const provider of manifest.providers) {
    const out = registry.register({
      id: provider.id,
      kind: provider.kind,
      version: provider.version,
      nodeId: provider.nodeId || manifest.nodeId,
      capabilities: provider.capabilities,
    }, providerAdapter(fetchInspection, provider.id));
    if (!out.ok && out.error !== 'provider_exists')
      return { configured: true, ok: false, error: out.error };
  }

  ready.add(gw);
  return { configured: true, ok: true, nodeId: manifest.nodeId };
}

async function ensureConfiguredComputerNode(gw, registry) {
  if (ready.has(gw)) return { configured: true, ok: true };
  if (connecting.has(gw)) return connecting.get(gw);

  const promise = connect(gw, registry)
    .catch(() => ({ configured: true, ok: false, error: 'node_unavailable' }))
    .finally(() => {
      if (!ready.has(gw)) connecting.delete(gw);
    });
  connecting.set(gw, promise);
  return promise;
}

module.exports = {
  config,
  isLoopbackHost,
  createInspectionFetcher,
  createActionInvoker,
  invokeConfiguredComputerNode,
  ensureConfiguredComputerNode,
};
