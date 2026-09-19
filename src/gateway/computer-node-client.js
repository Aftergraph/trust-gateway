'use strict';
// Optional bridge from Trust Gateway to an external Aftergraph Computer Node.
// Secrets stay in process env / closure and are never registered or projected.

const connecting = new WeakMap();
const ready = new WeakSet();

function config() {
  const url = process.env.TG_COMPUTER_NODE_URL || '';
  const token = process.env.TG_COMPUTER_NODE_TOKEN || '';
  if (!url && !token) return { configured: false };
  if (!url || !token) return { configured: true, ok: false, error: 'incomplete_configuration' };
  let parsed;
  try { parsed = new URL(url); } catch { return { configured: true, ok: false, error: 'bad_url' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    return { configured: true, ok: false, error: 'bad_url' };
  return { configured: true, ok: true, url: parsed.toString().replace(/\/$/, ''), token };
}

async function jsonFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`computer_node_http_${res.status}`);
  return res.json();
}

function providerAdapter(baseUrl, token, providerId) {
  return {
    async inspectHealth({ depth }) {
      const out = await jsonFetch(`${baseUrl}/v1/inspect`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'health', depth }),
      });
      const findings = Array.isArray(out && out.findings)
        ? out.findings
          .filter((f) => f && f.providerId === providerId)
          .map(({ providerId: _providerId, ...f }) => f)
        : [];
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

  for (const provider of manifest.providers) {
    const out = registry.register({
      id: provider.id,
      kind: provider.kind,
      version: provider.version,
      nodeId: provider.nodeId || manifest.nodeId,
      capabilities: provider.capabilities,
    }, providerAdapter(cfg.url, cfg.token, provider.id));
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

module.exports = { config, ensureConfiguredComputerNode };
