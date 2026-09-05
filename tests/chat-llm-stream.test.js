// A2 TDD — POST /v2/chat/llm/stream: SSE token-streaming med governed afslutning.
// Visning streamer løbende; GOVERNANCE sker på hele svaret (done-event bærer
// proposal/verdict fra samme classify/decide + approvals som /v2/chat/llm).
// Fallback (uden TG_LLM_*) → én done-event med fallback:true, ingen 5xx.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-llm-stream-')), 'gateway.db');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const streamMount = require('../src/gateway/mounts/147-chat-llm-stream.js');

function makeGateway(opts = {}) {
  return new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    mounts: [streamMount],
    ...opts,
  });
}

function sseRequest(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v2/chat/llm/stream', headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'content-length': Buffer.byteLength(data),
    } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', raw }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\n\n/)) {
    const ev = { event: 'message', data: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      if (line.startsWith('data:')) ev.data = line.slice(5).trim();
    }
    if (ev.data !== null) { try { ev.data = JSON.parse(ev.data); } catch { /* keep raw */ } events.push(ev); }
  }
  return events;
}

test('stream mount: registered as POST /v2/chat/llm/stream', () => {
  assert.equal(streamMount.method, 'POST');
  assert.ok(String(streamMount.path).includes('stream'));
});

test('stream: fallback brain → single done event with fallback:true, content-type SSE', async () => {
  const gw = makeGateway();
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await sseRequest(port, 'tok-op', { session: 's1', message: 'status?' });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/event-stream/);
    const events = parseSse(res.raw);
    const done = events.find((e) => e.event === 'done');
    assert.ok(done, 'done event present');
    assert.equal(done.data.fallback, true);
    assert.equal(typeof done.data.reply, 'string');
    assert.equal(events.filter((e) => e.event === 'delta').length, 0, 'no deltas in fallback');
  } finally { await new Promise((r) => server.close(r)); }
});

test('stream: stub brain streams deltas then governed done with proposal', async () => {
  const gw = makeGateway();
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const { getBrain } = require('../src/gateway/llm-brain');
    const brain = getBrain(gw);
    // stub chat-stream: leverer 3 chunks; propose-ruten genbruges til governance
    brain.chatStream = async function* () { yield 'Hej '; yield 'verden'; yield '!'; };
    const origPropose = brain.propose.bind(brain);
    brain.propose = async (message, opts) => ({
      reply: 'Hej verden!',
      proposal: { tool: 'fs.read:notes.txt', decision: 'pending' },
    });

    const res = await sseRequest(port, 'tok-op', { session: 's2', message: 'sig hej' });
    assert.equal(res.status, 200);
    const events = parseSse(res.raw);
    const deltas = events.filter((e) => e.event === 'delta');
    assert.equal(deltas.length, 3);
    assert.equal(deltas.map((d) => d.data.text).join(''), 'Hej verden!');
    const done = events.find((e) => e.event === 'done');
    assert.ok(done, 'done event');
    assert.equal(done.data.reply, 'Hej verden!');
    assert.deepEqual(done.data.proposal, { tool: 'fs.read:notes.txt', decision: 'pending' });
    brain.propose = origPropose;
    delete brain.chatStream;
  } finally { await new Promise((r) => server.close(r)); }
});

test('stream: message_required 400 på tom besked', async () => {
  const gw = makeGateway();
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await sseRequest(port, 'tok-op', { session: 's3', message: '' });
    assert.equal(res.status, 400);
  } finally { await new Promise((r) => server.close(r)); }
});
