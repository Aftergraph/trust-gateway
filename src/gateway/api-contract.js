'use strict';
// P2 — Developer platform v0: versioned API contract (OpenAPI 3.1) generated from
// the live mount surfaces.
//
// buildApiContract(mounts, {version}) introspects each mount's {name, method, path}
// and emits an OpenAPI 3.1 document:
//   - literal string paths (e.g. '/v2/router/route') -> exact path entries
//   - RegExp paths -> template entries derived from the pattern source (path
//     parameters marked {param}); regex internals are documented as pattern,
//     not guessed semantics
//   - method '*' mounts enumerate GET/POST/PUT/DELETE with "operation determined
//     at runtime" summaries (honest: the contract states shape, not behavior)
//   - auth: 'bearer' -> security requirement on the operation
//
// The contract is content-addressed (sha256 over the paths map) and versioned
// with the package version — the SDK (client.js) can pin against it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function regexToTemplate(re) {
  // Template derivation from the pattern source. Order matters: strip anchors and
  // optional-quantifier '?' FIRST (before param markers, so marker braces survive),
  // then map char-class/capture forms to {param}.
  let src = re.source || String(re);
  const BS = String.fromCharCode(92);
  const R = (from, to) => { src = src.split(from).join(to); };
  R('^', ''); R('$', '');
  R(BS + BS + '/', '/');   // double-escaped slash
  R(BS + '/', '/');        // single-escaped slash
  R('?', '');              // optional-quantifier strips BEFORE markers
  R('[/]+)?', 'param}');   // [^\/]+ forms after normalization
  R('[^/]+)?', 'param}');
  R('[/]+)', 'param');
  R('[^/]+)', 'param');
  R('(?:', '');
  R('(?!', '');
  R('(', '');
  R(')', '');
  if (src.includes('{') === false) src = '{pattern:' + src.slice(0, 60) + '}';
  return '/' + src.replace(/^\/+/, '');
}

function buildContract(mounts, { version = '0.0.0', generateAt = null, fnRoutes = null } = {}) {
  const paths = {};
  for (const m of mounts) {
    const methods = (m.method === '*' || m.method === undefined)
      ? ['get', 'post', 'put', 'delete', 'patch']
      : [String(m.method).toLowerCase()];
    let template;
    if (typeof m.path === 'string') {
      template = m.path;
    } else {
      template = regexToTemplate(m.path);
    }
    if (!template.startsWith('/')) template = '/' + template;
    paths[template] = paths[template] || {};
    for (const method of methods) {
      const key = method.toLowerCase();
      if (paths[template][key]) continue; // first mount wins per (path, method)
      paths[template][key] = {
        summary: `${m.name}: ${key.toUpperCase()} ${template}`,
        operationId: `${m.name}_${key}`,
        'x-auth': m.auth || 'none',
        'x-mount': m.name,
        responses: {
          '200': { description: 'success' },
          '4XX': { description: 'fail-closed error surface' },
        },
        ...(m.auth === 'bearer' ? { security: [{ bearerAuth: [] }] } : {}),
      };
    }
  }
  // Function-style mount routes (gw.router.get/post/...)
  if (Array.isArray(fnRoutes)) {
    for (const r of fnRoutes) {
      const method = String(r.method !== '*' ? r.method : 'get').toLowerCase();
      if (!paths[r.path]) paths[r.path] = {};
      if (paths[r.path][method]) continue;
      paths[r.path][method] = {
        summary: `fn-route: ${method.toUpperCase()} ${r.path}`,
        operationId: `fn_${r.path.replace(/[^a-zA-Z0-9]/g, '_')}_${method}`,
        'x-auth': 'bearer',
        'x-mount': 'fn-route',
        responses: { '200': { description: 'success' }, '4XX': { description: 'fail-closed error surface' } },
        security: [{ bearerAuth: [] }],
      };
    }
  }
  const contract = {
    openapi: '3.1.0',
    info: {
      title: 'Trust Gateway Product API',
      version: process.env.npm_package_version || '0.4.0',
      description: 'Versioned product API contract generated from the live mount surfaces (developer platform v0). The SDK (src/gateway/client.js) pins against this contract.',
      'x-contract-hash': sha16(paths),
      'x-generated-at': generateAt || new Date().toISOString(),
    },
    servers: [{ url: '/', description: 'gateway root' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths,
  };
  return contract;
}

function sha16(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/** Derive SDK surface summary: which operations the client can call. */
function sdkSurface(contract) {
  const surface = [];
  for (const [p, ops] of Object.entries(contract.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      surface.push({ method: method.toUpperCase(), path: p, operationId: op.operationId, auth: op['x-auth'] });
    }
  }
  return surface.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { buildContract, buildApiContract: buildContract, sdkSurface, sha16, regexToTemplate };