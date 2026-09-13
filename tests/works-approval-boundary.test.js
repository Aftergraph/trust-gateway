'use strict';
// W0.3 assurance: a configured WORKS failure must not mint a synthetic mission.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ORIGINAL = {
  WORKS_API_URL: process.env.WORKS_API_URL,
  WORKS_API_TOKEN: process.env.WORKS_API_TOKEN,
  TG_AIE_FAIL_OPEN: process.env.TG_AIE_FAIL_OPEN,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (server && server.listening) await new Promise((resolve) => server.close(resolve));
}

async function request(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      authorization: 'Bearer tok-atlas',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('configured WORKS failure leaves proposal submitted and uncorrelated', async () => {
  let worksCalls = 0;
  const worksServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/works') {
      worksCalls += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  let tgServer = null;
  try {
    const worksBase = await listen(worksServer);
    process.env.WORKS_API_URL = worksBase;
    process.env.WORKS_API_TOKEN = 'test-token';
    process.env.TG_AIE_FAIL_OPEN = 'true';

    const { Gateway } = require('../src/gateway/server');
    const gw = new Gateway({
      bots: { atlas: { token: 'tok-atlas', role: 'operator', capabilities: [] } },
      dispatch: async () => ({ ran: true }),
      mountFiles: false,
      mounts: [require('../src/gateway/mounts/23-missions.js')],
    });
    tgServer = http.createServer((req, res) => gw.handle(req, res));
    const tgBase = await listen(tgServer);

    const created = await request(tgBase, 'POST', '/v2/proposals', {
      proposer: 'agent_1',
      channel: 'chat',
      objective: 'must not become synthetic',
      proposed_mission: { objective: 'real WORKS required', success_criteria: ['persisted'] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const proposalId = created.body.proposal.id;

    const submitted = await request(tgBase, 'POST', `/v2/proposals/${proposalId}/submit`, {});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

    const approval = await request(tgBase, 'POST', `/v2/proposals/${proposalId}/approve`, { approver: 'atlas' });
    assert.equal(approval.status, 502, JSON.stringify(approval.body));
    assert.equal(approval.body.error, 'works_submission_failed');

    const current = await request(tgBase, 'GET', `/v2/proposals/${proposalId}`);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.status, 'submitted');
    assert.equal(current.body.converted_to_mission_id, null);
    assert.equal(worksCalls, 1);
  } finally {
    await close(tgServer);
    await close(worksServer);
    restoreEnv();
  }
});
