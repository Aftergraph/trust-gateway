// B3 TDD — knowledge-citations i rooms ask.
// POST /v2/rooms/:id/ask {message, useKnowledge:true}
//   1) knowledge.search(message) top-3 (tenant-visible)
//   2) kontekst sendes til brain som del af prompten (implementation-detalle:
//      vi bruger brain.propose med message + [KB] præfiks-note i session —
//      kontrakt: response + assistant-envelope bærer citations: [ids])
//   3) cite(id, {ref_type:'room_message', ref_id: messageId}) registreres pr. kilde
// Fail-closed: knowledge utilgængelig → ingen citations, svar går igennem som normalt.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-b3-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-b3-rooms-')), 'rooms.json');
process.env.TG_KNOWLEDGE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-b3-kb-')), 'knowledge.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');

function makeGateway() {
  return new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    mounts: [
      require('../src/gateway/mounts/25-groups.js'),
      require('../src/gateway/mounts/146-rooms-ask.js'),
      require('../src/gateway/mounts/18-knowledge.js'),
    ],
  });
}
function req(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    }); r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function boot(gw) {
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { server, port };
}

test('B3: ask med useKnowledge → citations i response + envelope + cite() kaldt', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    // opret knowledge source om lash-coffee (tenant-visible)
    const k = await req(port, 'POST', '/v2/knowledge', 'tok-op', {
      title: 'Lash coffee policy', kind: 'doc', visibility: 'tenant',
      content: 'Kunder der bestiller lash-behandling får gratis coffee under sessionen.',
    });
    assert.equal(k.status, 201, JSON.stringify(k.body).slice(0,120));
    const kbId = k.body.source.id;

    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'b3', bots: ['op'] });
    const roomId = c.body.room.id;

    // stub brain for determinisme — fang hvilken besked der sendes
    const { getBrain } = require('../src/gateway/llm-brain');
    const brain = getBrain(gw);
    let seenMessage = null;
    const orig = brain.propose.bind(brain);
    brain.propose = async (message, opts) => { seenMessage = message; return { reply: 'Kunden får coffee.' }; };

    const a = await req(port, 'POST', `/v2/rooms/${roomId}/ask`, 'tok-op', {
      message: 'får kunden coffee?', useKnowledge: true });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(Array.isArray(a.body.citations) && a.body.citations.includes(kbId), 'citation i response');

    // kontekst nåede frem til brain (knowledge-note er en del af prompten)
    assert.ok(seenMessage && seenMessage.includes('Lash coffee policy'), 'KB-kontekst i prompt');

    // assistant-envelope i tråden bærer citations
    const d = await req(port, 'GET', `/v2/rooms/${roomId}`, 'tok-op');
    const asst = (d.body.room.messages || []).find((m) => m.kind === 'assistant');
    assert.ok(asst, 'assistant envelope');
    assert.ok(Array.isArray(asst.citations) && asst.citations.includes(kbId), 'citation i envelope');

    // cite() registreret på kilden
    const src = await req(port, 'GET', `/v2/knowledge/${kbId}`, 'tok-op');
    const cites = (src.body.source ? src.body.source.citations : src.body.citations) || [];
    assert.ok(cites.some((c2) => c2.ref_type === 'room_message'), 'cite() recorded');

    brain.propose = orig;
  } finally { await new Promise((r) => server.close(r)); }
});

test('B3: uden useKnowledge → ingen citations, ingen KB-prompt', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'b3b', bots: ['op'] });
    const roomId = c.body.room.id;
    const a = await req(port, 'POST', `/v2/rooms/${roomId}/ask`, 'tok-op', { message: 'hej' });
    assert.equal(a.status, 200);
    assert.equal(a.body.citations, undefined);
  } finally { await new Promise((r) => server.close(r)); }
});
