'use strict';
// Trust Gateway v2 — Server-Sent Events hub.
//
// EventHub subscribes once to its gateway's 'audit' event in the constructor
// and fans every sealed entry out to all connected SSE clients. Clients are
// raw http.ServerResponse objects (set up by the mount handler).
//
// Event wire format (one frame per audit entry):
//   event: audit
//   data: {"seq":1,"ts":...,"hash":"...","payload":{...}}
//
//   (blank line terminates the frame)
//
// On connect, the hub writes SSE headers, a `retry: 3000` directive, and
// one immediate `hello` event so the browser can confirm the stream is live.
// A 25s keepalive comment (`: keepalive\n\n`) is pushed via an unref'd timer
// so it never holds the process open on its own.

const HEARTBEAT_MS = 25_000;
const HUB_WEAK_MAP = new WeakMap(); // gateway -> EventHub

// FS-I4: fire-and-forget export tap. After a successful chain append,
// server.js emits 'audit'; this hook streams the sealed entry to the
// operator-configured export sinks (webhook / S3 stub) WITHOUT ever
// blocking or breaking the audit path — the promise is intentionally not
// awaited and every rejection is swallowed inside ExportSink.emit(). With
// both TG_AUDIT_EXPORT_* env vars unset the sink is inert (zero calls,
// byte-identical legacy behavior). Module-level WeakMap sink, same pattern
// as getAlertSink / getHub.
function wireExportSink(gateway) {
  try {
    if (!gateway || gateway._auditExportWired) return; // idempotent
    const { getExportSink } = require('./audit-export');
    const sink = getExportSink(gateway);
    if (sink.inert) return; // env-off: nothing registered at all
    gateway._auditExportWired = true;
    gateway.on('audit', (entry) => {
      // Fire-and-forget by design — audit append must never wait on sinks.
      Promise.resolve(sink.emit(entry)).catch(() => { /* never crash */ });
    });
  } catch { /* export wiring must never break gateway construction */ }
}

class EventHub {
  constructor(gateway) {
    this.gateway = gateway;
    this.clients = new Set();
    // FS-E1d: per-client scope filter (tenant-scoped /v2/events). A client
    // registered WITH a filter receives only audit frames whose entry passes
    // the filter; broadcast() frames (artifact/computer/room projections,
    // which carry no tenant tag) are never delivered to filtered clients.
    // No filter (main / default) → byte-identical behavior.
    this._filters = new Map(); // res -> filter(entry)
    this._heartbeat = setInterval(() => {
      // Best-effort write to every client. A dead socket throws on write;
      // we ignore here and let the response's 'close' handler remove it.
      for (const res of this.clients) {
        try { res.write(': keepalive\n\n'); } catch { /* will be cleaned up on close */ }
      }
    }, HEARTBEAT_MS);
    // unref so the heartbeat never keeps the event loop alive on its own
    if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
    // subscribe once for the lifetime of this hub
    this._onAudit = (entry) => this._broadcastAudit(entry);
    this.gateway.on('audit', this._onAudit);
    // FS-I4: stream sealed entries to operator-configured export sinks
    // (webhook / S3 stub) — inert when env unset, fire-and-forget always.
    wireExportSink(this.gateway);
  }

  // Stop emitting and detach listeners. Mostly for tests / clean shutdown.
  close() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    if (this._onAudit) this.gateway.off('audit', this._onAudit);
    this._onAudit = null;
    this._filters.clear();
    for (const res of this.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  clientCount() {
    return this.clients.size;
  }

  _broadcastAudit(entry) {
    const frame = `event: audit\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.clients) {
      const filter = this._filters.get(res);
      if (filter && !filter(entry)) continue; // tenant-scoped client: entry not theirs
      try { res.write(frame); } catch { /* dead socket; 'close' handler will remove */ }
    }
  }

  // Generic broadcast for future use (e.g. pending approval notifications).
  // Mounts/modules can call hub.broadcast('pending', { id, ... }) and any
  // connected client will receive `event: pending\ndata: <json>\n\n`.
  broadcast(type, payload) {
    if (typeof type !== 'string' || type.length === 0) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { /* dead socket; ignore */ }
    }
  }

  addClient(res, filter) {
    if (typeof filter === 'function') this._filters.set(res, filter);
    // SSE response headers. X-Accel-Buffering:no tells nginx (and any other
    // reverse proxy) to flush each frame immediately rather than buffering.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Hint to EventSource how long to wait before reconnecting if the
    // stream drops. 3s is a reasonable default that doesn't hammer the
    // server during outages.
    res.write('retry: 3000\n\n');
    // Immediate hello with the chain head so the client can render state
    // without waiting for the next audit event.
    const head = this.gateway.chain && this.gateway.chain.head;
    const hello = head
      ? { head: head.hash, seq: head.seq, chainId: this.gateway.chain.chainId }
      : { head: null, seq: 0, chainId: null };
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    this.clients.add(res);
    const remove = () => this.clients.delete(res);
    res.on('close', remove);
    res.on('error', remove);
  }
}

// Lazily attach exactly one hub per gateway instance. Uses a WeakMap so the
// hub can be garbage-collected with the gateway (no leak if the gateway is
// thrown away in tests).
function getHub(gateway) {
  let hub = HUB_WEAK_MAP.get(gateway);
  if (!hub) {
    hub = new EventHub(gateway);
    HUB_WEAK_MAP.set(gateway, hub);
  }
  return hub;
}

module.exports = { EventHub, getHub, HEARTBEAT_MS, wireExportSink,
  // v2 function-style mounts (120+) use a standalone audit(type, payload)
  // helper that writes to the shared DB chain when available, and is a
  // no-op otherwise. Object-style mounts keep using gw._audit().
  audit(type, payload) {
    try {
      const { db } = require('./db');
      const { entryHash } = require('./hash-chain');
      const prevRow = db.prepare('SELECT seq, hash FROM chain_entries ORDER BY seq DESC LIMIT 1').get();
      const seq = (prevRow ? Number(prevRow.seq) : -1) + 1;
      const prevHash = prevRow ? prevRow.hash : '0'.repeat(64);
      const ts = Date.now();
      const body = { type, ...payload };
      const rt = JSON.parse(JSON.stringify(body));
      const hash = entryHash(seq, prevHash, ts, rt);
      db.prepare('INSERT INTO chain_entries(seq, ts, prev_hash, hash, payload) VALUES(?,?,?,?,?)')
        .run(seq, ts, prevHash, hash, JSON.stringify(rt));
    } catch { /* observability only, never throws */ }
  },
};
