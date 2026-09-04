'use strict';
// v2 mount: GET /v2/hash/export?format=json|pdf
// Exports the full hash-chain as JSON (entries array) or simple PDF summary.
// Auth: bearer (same as other v2 API routes).

const { send } = require('../server');

module.exports = {
  name: 'v2-hash-export',
  method: 'GET',
  path: '/v2/hash/export',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const format = ctx.url.searchParams.get('format') || 'json';

    if (format === 'json') {
      // Export full chain as JSON with metadata
      const result = {
        chainId: gw.chain.chainId,
        genesis: gw.chain.entries[0],
        totalEntries: gw.chain.entries.length,
        entries: gw.chain.entries,
        verified: gw.chain.verify(),
      };
      return send(res, 200, result);
    } else if (format === 'pdf') {
      // Simple text-based PDF (ASCII representation)
      const v = gw.chain.verify();
      const lines = [
        'PDF Summary: Trust Gateway Audit Chain',
        '='.repeat(50),
        '',
        `Chain ID: ${gw.chain.chainId}`,
        `Total Entries: ${gw.chain.entries.length}`,
        `Genesis Seq: 0`,
        `Head Seq: ${gw.chain.head.seq}`,
        `Verified: ${v.ok ? 'YES' : 'NO'}`,
        ``,
        'Entry Summary:',
        '-'.repeat(50),
        ...gw.chain.entries.map(e =>
          `  seq=${e.seq} ts=${new Date(e.ts).toISOString()} hash=${e.hash.slice(0, 16)}...`
        ),
        '',
        `Verification Result: ${JSON.stringify(v)}`,
        '='.repeat(50),
      ];
      const pdfContent = lines.join('\n');
      res.writeHead(200, {
        'content-type': 'application/pdf; charset=utf-8',
        'content-length': Buffer.byteLength(pdfContent),
      });
      return res.end(pdfContent);
    } else {
      return send(res, 400, { error: 'invalid_format', valid: ['json', 'pdf'] });
    }
  },
};
