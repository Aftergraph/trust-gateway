'use strict';

const crypto = require('node:crypto');
const nodeHttp = require('node:http');
const nodeHttps = require('node:https');
const net = require('node:net');

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const HEADER_NAME = /^[!#$%&'*+\-.^_\`|~0-9A-Za-z]+$/;
const METHOD = /^[!#$%&'*+\-.^_\`|~0-9A-Za-z]+$/;
const RESERVED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);

function fail(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAddress(value) {
  if (typeof value !== 'string') return '';
  const address = value.trim();
  return address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
}

function normalizeAdmittedAddresses(context) {
  if (!Array.isArray(context?.resolvedAddresses) || context.resolvedAddresses.length === 0) {
    throw fail('address_pin_required');
  }

  const addresses = [...new Set(context.resolvedAddresses.map(normalizeAddress).filter(Boolean))].sort();
  if (addresses.length === 0) throw fail('address_pin_required');
  if (addresses.some((address) => net.isIP(address) === 0)) throw fail('address_pin_invalid');
  return addresses;
}

function normalizeHost(destination) {
  if (typeof destination?.host !== 'string') throw fail('destination_host_invalid');
  const host = destination.host.trim().toLowerCase();
  if (!host || CONTROL_CHARACTERS.test(host) || /\s/.test(host) ||
      /[/?#\\]/.test(host)) {
    throw fail('destination_host_invalid');
  }
  return host;
}

function normalizePort(destination) {
  const port = Number(destination?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw fail('destination_port_invalid');
  }
  return port;
}

function normalizeScheme(destination) {
  const scheme = String(destination?.scheme || '').trim().toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') throw fail('destination_scheme_invalid');
  return scheme;
}

function normalizeMethod(http) {
  const method = String(http?.method || '').trim().toUpperCase();
  if (!METHOD.test(method)) throw fail('http_method_invalid');
  return method;
}

function serializeQuery(query) {
  if (query == null) return '';
  if (!isRecord(query)) throw fail('query_invalid');

  const pairs = [];
  for (const key of Object.keys(query).sort()) {
    if (CONTROL_CHARACTERS.test(key)) throw fail('query_key_invalid');
    const rawValues = Array.isArray(query[key]) ? query[key] : [query[key]];
    if (rawValues.length === 0) continue;

    for (const value of rawValues) {
      const type = typeof value;
      if (value === null || value === undefined ||
          (type === 'number' && !Number.isFinite(value)) ||
          !['string', 'number', 'boolean', 'bigint'].includes(type)) {
        throw fail('query_value_invalid');
      }
      const encodedValue = String(value);
      if (CONTROL_CHARACTERS.test(encodedValue)) throw fail('query_value_invalid');
      pairs.push([key, encodedValue]);
    }
  }
  return new URLSearchParams(pairs).toString();
}

function normalizePath(http) {
  if (typeof http?.path !== 'string') throw fail('http_path_invalid');
  const path = http.path;
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') ||
      CONTROL_CHARACTERS.test(path)) {
    throw fail('http_path_invalid');
  }

  const query = serializeQuery(http.query);
  return query ? path + '?' + query : path;
}

function normalizeHeaderValue(value) {
  const type = typeof value;
  if (type !== 'string' && type !== 'number') throw fail('header_value_invalid');
  const normalized = String(value);
  if (CONTROL_CHARACTERS.test(normalized)) throw fail('header_value_invalid');
  return normalized;
}

function normalizeHeaders(headers) {
  if (headers == null) return {};
  if (!isRecord(headers)) throw fail('headers_invalid');

  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).trim().toLowerCase();
    if (!name || !HEADER_NAME.test(name)) throw fail('header_name_invalid');
    if (RESERVED_HEADERS.has(name)) throw fail('reserved_transport_header');

    if (Array.isArray(rawValue)) {
      if (rawValue.length === 0) throw fail('header_value_invalid');
      out[name] = rawValue.map(normalizeHeaderValue);
    } else {
      out[name] = normalizeHeaderValue(rawValue);
    }
  }
  return out;
}

function normalizeBody(http, maxRequestBytes) {
  if (http?.body == null) {
    if (http?.bodyDigest != null) throw fail('request_body_digest_mismatch');
    return null;
  }

  let body;
  if (typeof http.body === 'string') {
    body = Buffer.from(http.body, 'utf8');
  } else if (Buffer.isBuffer(http.body)) {
    body = Buffer.from(http.body);
  } else if (http.body instanceof Uint8Array) {
    body = Buffer.from(http.body);
  } else {
    throw fail('request_body_invalid');
  }

  if (body.length > maxRequestBytes) throw fail('request_body_too_large');

  const expectedDigest = String(http.bodyDigest || '').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
    throw fail('request_body_digest_required');
  }
  const actualDigest = 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
  if (actualDigest !== expectedDigest) throw fail('request_body_digest_mismatch');
  return body;
}

function normalizeOptions(options) {
  if (!isRecord(options)) throw fail('transport_options_invalid');

  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (const [name, value] of [
    ['maxRequestBytes', maxRequestBytes],
    ['maxResponseBytes', maxResponseBytes],
    ['timeoutMs', timeoutMs],
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw fail(name + '_invalid');
  }

  const httpModule = options.httpModule || nodeHttp;
  const httpsModule = options.httpsModule || nodeHttps;
  if (typeof httpModule?.request !== 'function' ||
      typeof httpsModule?.request !== 'function') {
    throw fail('transport_module_invalid');
  }

  const selectAddress = options.selectAddress || ((addresses) => addresses[0]);
  if (typeof selectAddress !== 'function') throw fail('address_selector_invalid');

  return {
    httpModule,
    httpsModule,
    maxRequestBytes,
    maxResponseBytes,
    timeoutMs,
    selectAddress,
  };
}

function normalizeTransportError(error) {
  if (error?.code && String(error.code).startsWith('transport_')) return error;
  const normalized = fail('transport_failed');
  if (error?.code) normalized.causeCode = String(error.code);
  return normalized;
}

function executeRequest({
  clientModule,
  requestOptions,
  body,
  admittedAddresses,
  maxResponseBytes,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let clientRequest;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (error) reject(error);
      else resolve(result);
    };
    const failTransport = (error) => finish(normalizeTransportError(error));

    const onResponse = (response) => {
      let bytes = 0;
      const chunks = [];

      response.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        bytes += buffer.length;
        if (bytes > maxResponseBytes) {
          const error = fail('response_too_large');
          finish(error);
          try { response.destroy(); } catch { /* best effort */ }
          try { clientRequest?.destroy(); } catch { /* best effort */ }
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', failTransport);
      response.on('aborted', () => finish(fail('response_aborted')));

      response.on('end', () => {
        if (settled) return;
        const connectedAddress = normalizeAddress(
          response.socket?.remoteAddress || clientRequest?.socket?.remoteAddress,
        );
        if (!connectedAddress || !admittedAddresses.includes(connectedAddress)) {
          finish(fail('transport_address_not_pinned'));
          return;
        }

        finish(null, {
          status: Number(response.statusCode || 0),
          headers: isRecord(response.headers) ? { ...response.headers } : {},
          body: Buffer.concat(chunks).toString('utf8'),
          connectedAddress,
        });
      });
    };

    try {
      clientRequest = clientModule.request(requestOptions, onResponse);
    } catch (error) {
      failTransport(error);
      return;
    }

    if (!clientRequest || typeof clientRequest.on !== 'function' ||
        typeof clientRequest.end !== 'function') {
      finish(fail('transport_client_invalid'));
      return;
    }

    clientRequest.on('error', failTransport);
    timer = setTimeout(() => {
      const error = fail('transport_timeout');
      finish(error);
      try { clientRequest.destroy(error); } catch { /* best effort */ }
    }, timeoutMs);

    try {
      if (body === null) clientRequest.end();
      else clientRequest.end(body);
    } catch (error) {
      failTransport(error);
    }
  });
}

function createPinnedTransport(options = {}) {
  const normalizedOptions = normalizeOptions(options);

  return async function pinnedTransport(request, context = {}) {
    if (!context || context.requireAddressPinning !== true) {
      throw fail('address_pinning_required');
    }
    if (typeof context.permitId !== 'string' || context.permitId.trim() === '') {
      throw fail('commit_permit_required');
    }

    const admittedAddresses = normalizeAdmittedAddresses(context);
    const destination = request?.destination || {};
    const http = request?.http || {};
    const scheme = normalizeScheme(destination);
    const host = normalizeHost(destination);
    const port = normalizePort(destination);
    const method = normalizeMethod(http);
    const path = normalizePath(http);
    const body = normalizeBody(http, normalizedOptions.maxRequestBytes);
    const headers = normalizeHeaders(http.headers);

    if (body !== null) headers['content-length'] = String(body.length);

    const selectedAddress = normalizeAddress(normalizedOptions.selectAddress([...admittedAddresses]));
    if (!selectedAddress || !admittedAddresses.includes(selectedAddress)) {
      throw fail('address_selection_invalid');
    }

    const lookup = (_hostname, lookupOptions, callback) => {
      const family = net.isIP(selectedAddress);
      if (lookupOptions?.all === true) {
        callback(null, [{ address: selectedAddress, family }]);
      } else {
        callback(null, selectedAddress, family);
      }
    };
    const requestOptions = {
      protocol: scheme + ':',
      hostname: host,
      port,
      method,
      path,
      headers,
      agent: false,
      lookup,
      timeout: normalizedOptions.timeoutMs,
    };
    if (scheme === 'https') requestOptions.servername = host;

    const clientModule = scheme === 'https'
      ? normalizedOptions.httpsModule
      : normalizedOptions.httpModule;

    return executeRequest({
      clientModule,
      requestOptions,
      body,
      admittedAddresses,
      maxResponseBytes: normalizedOptions.maxResponseBytes,
      timeoutMs: normalizedOptions.timeoutMs,
    });
  };
}

module.exports = {
  createPinnedTransport,
};
