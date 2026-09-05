'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-works-')), 'gateway.db');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const worksProxy = require('../src/gateway/mounts/131-works-proxy');

function makeWorksMock(routes) {
  return http.createServer((req, res) => {
    const match = routes.find((r) => r.method === req.method && req.url.startsWith(r.pathPrefix));
    if (!match) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    res.setHeader('content-type', 'application/json');
    res.statusCode = match.status ?? 200;
    res.end(JSON.stringify(match.body ?? {}));
  });
}

function fetchJson(port, token, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    }).on('error', reject);
  });
}

test('works-proxy: returns 503 works_disabled when WORKS_API_URL is unset', async () => {
  const saved = process.env.WORKS_API_URL;
  delete process.env.WORKS_API_URL;
  const gw = new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false, fnMounts: [worksProxy],
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/executions');
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'works_disabled');
  } finally {
    await new Promise((r) => server.close(r));
    if (saved !== undefined) process.env.WORKS_API_URL = saved;
  }
});

test('works-proxy: list works passes through from WORKS API', async () => {
  const mock = makeWorksMock([
    { method: 'GET', pathPrefix: '/v1/works', status: 200, body: { works: [{ id: 'wrk_1', state: 'QUEUED' }], count: 1 } },
  ]);
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const saved = process.env.WORKS_API_URL;
  process.env.WORKS_API_URL = `http://127.0.0.1:${mockPort}`;
  const gw = new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false, fnMounts: [worksProxy],
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/executions');
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 1);
    assert.equal(r.body.works[0].id, 'wrk_1');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    if (saved !== undefined) process.env.WORKS_API_URL = saved; else delete process.env.WORKS_API_URL;
  }
});

test('works-proxy: single work detail + 404 pass-through', async () => {
  const mock = makeWorksMock([
    { method: 'GET', pathPrefix: '/v1/works/wrk_found', status: 200, body: { id: 'wrk_found', state: 'SUCCEEDED' } },
    { method: 'GET', pathPrefix: '/v1/works/wrk_missing', status: 404, body: { error: 'not_found' } },
  ]);
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const saved = process.env.WORKS_API_URL;
  process.env.WORKS_API_URL = `http://127.0.0.1:${mockPort}`;
  const gw = new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false, fnMounts: [worksProxy],
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const found = await fetchJson(port, 'tok-op', '/v2/executions/wrk_found');
    assert.equal(found.status, 200);
    assert.equal(found.body.work.id, 'wrk_found');
    const missing = await fetchJson(port, 'tok-op', '/v2/executions/wrk_missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'work_not_found');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    if (saved !== undefined) process.env.WORKS_API_URL = saved; else delete process.env.WORKS_API_URL;
  }
});

test('works-proxy: evidence endpoint returns evidence list', async () => {
  const mock = makeWorksMock([
    { method: 'GET', pathPrefix: '/v1/works/wrk_ev/evidence', status: 200, body: { evidence: [{ kind: 'log' }] } },
  ]);
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const saved = process.env.WORKS_API_URL;
  process.env.WORKS_API_URL = `http://127.0.0.1:${mockPort}`;
  const gw = new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false, fnMounts: [worksProxy],
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/executions/wrk_ev/evidence');
    assert.equal(r.status, 200);
    assert.equal(r.body.evidence.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    if (saved !== undefined) process.env.WORKS_API_URL = saved; else delete process.env.WORKS_API_URL;
  }
});
