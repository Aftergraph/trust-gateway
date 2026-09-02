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

class EventHub {
  constructor(gateway) {
    this.gateway = gateway;
    this.clients = new Set();
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
  }

  // Stop emitting and detach listeners. Mostly for tests / clean shutdown.
  close() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    if (this._onAudit) this.gateway.off('audit', this._onAudit);
    this._onAudit = null;
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

  addClient(res) {
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

module.exports = { EventHub, getHub, HEARTBEAT_MS };
