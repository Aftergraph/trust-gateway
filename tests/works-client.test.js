'use strict';
// W0.3 works-client tests: fail-closed when unconfigured, correlation on success,
// graceful degradation on unreachable/auth-fail. No real WORKS control plane needed.
const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_URL = process.env.WORKS_API_URL;
const ORIGINAL_TOKEN = process.env.WORKS_API_TOKEN;

test.after(() => {
  if (ORIGINAL_URL === undefined) delete process.env.WORKS_API_URL; else process.env.WORKS_API_URL = ORIGINAL_URL;
  if (ORIGINAL_TOKEN === undefined) delete process.env.WORKS_API_TOKEN; else process.env.WORKS_API_TOKEN = ORIGINAL_TOKEN;
});

test('createWork fails closed when WORKS_API_URL unset (disabled)', async () => {
  delete process.env.WORKS_API_URL;
  const { createWork } = require('../src/gateway/works-client');
  const out = await createWork({ objective: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'disabled');
});

test('createWork reaches a local mock control plane and returns the Work ID', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/works' && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'work_123' }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.WORKS_API_URL = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('../src/gateway/works-client')];
  const { createWork } = require('../src/gateway/works-client');

  const out = await createWork({ objective: 'deploy', mission_id: 'proposal_x' });
  await new Promise((r) => server.close(r));
  assert.equal(out.ok, true);
  assert.equal(out.work_id, 'work_123');
});

test('createWork degrades gracefully on unreachable control plane', async () => {
  process.env.WORKS_API_URL = 'http://127.0.0.1:9'; // nothing listens there
  const { createWork } = require('../src/gateway/works-client');
  const out = await createWork({ objective: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /works_unreachable/);
});

test('createWork fails closed on auth failure', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.WORKS_API_URL = `http://127.0.0.1:${server.address().port}`;
  const { createWork } = require('../src/gateway/works-client');
  const out = await createWork({ objective: 'x' });
  await new Promise((r) => server.close(r));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'works_auth_failed');
});