#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function runProbe() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-study015-'));
  const priorDb = process.env.TG_DB_FILE;
  const priorFailOpen = process.env.TG_AIE_FAIL_OPEN;
  process.env.TG_DB_FILE = path.join(tmp, 'gateway.db');
  // Component isolation: AIE behavior is proved by the AIE probe. The TG probe
  // must exercise TG policy/approval/audit without requiring a second runtime.
  process.env.TG_AIE_FAIL_OPEN = 'true';

  // Require only after the isolated env is installed.
  const { Gateway } = require('../src/gateway/server');
  const { GatewayClient } = require('../src/gateway/client');

  const dispatches = [];
  const gw = new Gateway({
    telemetryFile: null,
    bots: {
      forge: {
        name: 'forge',
        token: 'tok-forge-study015',
        role: 'worker',
        capabilities: ['fs.read', 'fs.write:*'],
      },
      atlas: {
        name: 'atlas',
        token: 'tok-atlas-study015',
        role: 'operator',
        capabilities: ['*'],
      },
    },
    dispatch: async (bot, tool, args) => {
      dispatches.push({ bot: bot.name, tool, args: args ?? null });
      return { ok: true, tool };
    },
  });

  const server = http.createServer((req, res) => gw.handle(req, res));
  let baseUrl;
  try {
    baseUrl = await listen(server);
    const worker = new GatewayClient({ baseUrl, token: 'tok-forge-study015' });
    const operator = new GatewayClient({ baseUrl, token: 'tok-atlas-study015' });
    const intruder = new GatewayClient({ baseUrl, token: 'wrong-token' });

    const read = await worker.action('fs.read:notes/x.md');
    if (read.decision !== 'allow' || !read.result) {
      throw new Error(`read path did not auto-allow: ${JSON.stringify(read)}`);
    }

    const destructive = await worker.action('shell.run', { cmd: 'echo study015' });
    if (destructive.decision !== 'needs_approval' || !destructive.approvalId) {
      throw new Error(`destructive path did not park: ${JSON.stringify(destructive)}`);
    }
    const shellBeforeApproval = dispatches.filter((d) => d.tool === 'shell.run').length;
    if (shellBeforeApproval !== 0) {
      throw new Error('destructive action dispatched before approval');
    }

    const forbidden = await worker.approve(destructive.approvalId);
    if (forbidden.error !== 'operator_required') {
      throw new Error(`worker unexpectedly approved destructive action: ${JSON.stringify(forbidden)}`);
    }

    const approved = await operator.approve(destructive.approvalId);
    if (approved.status !== 'approved' || !approved.result?.ok) {
      throw new Error(`operator approval did not execute: ${JSON.stringify(approved)}`);
    }
    const shellAfterApproval = dispatches.filter((d) => d.tool === 'shell.run').length;
    if (shellAfterApproval !== 1) {
      throw new Error(`approved action dispatch count was ${shellAfterApproval}, expected 1`);
    }

    const unauthorized = await intruder.action('fs.read:notes/x.md');
    if (unauthorized.error !== 'unauthorized') {
      throw new Error('invalid bearer token did not fail closed');
    }

    const audit = await worker.verify();
    if (audit.ok !== true || !audit.head || !audit.chainId) {
      throw new Error(`audit chain did not verify: ${JSON.stringify(audit)}`);
    }

    return {
      schema: 'study015.probe/1.0',
      component: 'trust-gateway',
      source_head: gitHead(),
      execution_class: 'LOCAL_IMPLEMENTATION_PROBE',
      network_used: false,
      component_isolation: { aie_revalidation: 'separately_probed' },
      mechanisms: {
        capability_policy_enforcement: true,
        destructive_requires_approval: true,
        worker_cannot_self_approve: true,
        operator_approval_executes_once: true,
        invalid_identity_fails_closed: true,
        tamper_evident_audit_verifies: true,
      },
      observations: {
        read_decision: read.decision,
        destructive_decision: destructive.decision,
        worker_approval_error: forbidden.error,
        operator_status: approved.status,
        shell_dispatch_count: shellAfterApproval,
        audit_length: audit.length,
        audit_head: audit.head,
      },
    };
  } finally {
    if (baseUrl) await close(server);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (priorDb === undefined) delete process.env.TG_DB_FILE;
    else process.env.TG_DB_FILE = priorDb;
    if (priorFailOpen === undefined) delete process.env.TG_AIE_FAIL_OPEN;
    else process.env.TG_AIE_FAIL_OPEN = priorFailOpen;
  }
}

if (require.main === module) {
  runProbe()
    .then((receipt) => {
      process.stdout.write(JSON.stringify(receipt) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runProbe };
