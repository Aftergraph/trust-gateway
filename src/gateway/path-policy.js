'use strict';

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// Canonicalize an HTTP path exactly once before policy evaluation. Encoded
// separators, traversal tokens and control characters fail closed so an
// adapter cannot interpret a different path after admission.
function canonicalPath(rawPath) {
  const raw = String(rawPath ?? '');
  if (!raw.startsWith('/') || raw.includes('\u0000')) throw fail('path_invalid');
  // Reject encoded separators and dot-segments before decoding: otherwise
  // normalization could silently turn an encoded traversal into a permitted
  // path with different downstream interpretation.
  if (/%2f|%5c|%2e/i.test(raw)) throw fail('path_encoded_separator');
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw fail('path_invalid_encoding');
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || /%2f|%5c|%2e/i.test(decoded)) {
    throw fail('path_encoded_separator');
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) throw fail('path_control_character');

  const normalized = [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (normalized.length === 0) throw fail('path_traversal');
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  const result = `/${normalized.join('/')}`;
  return decoded.endsWith('/') && result !== '/' ? `${result}/` : result;
}

function pathWithinPrefix(rawPath, rawPrefix) {
  const path = canonicalPath(rawPath);
  const prefix = canonicalPath(rawPrefix);
  const base = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  return base === '' ? path.startsWith('/') : path === base || path.startsWith(`${base}/`);
}

module.exports = { canonicalPath, pathWithinPrefix };