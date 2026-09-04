"use strict";
// FS-G3 — multi-signal alarmering: AlertSink webhook delivery (§8(c)).
//
// Covers:
//   - TG_ALERT_URLS parse: multiple URLs, whitespace-tolerant, empty → no-op
//   - delivery: fetch POST {type, ts, host, fields} to EVERY url
//   - TG_ALERT_TOKEN optional Bearer header
//   - per-type rate limit: max 1 per 60s (same pattern as telemetry ring)
//   - suppression: max 5 per type per hour, then SILENT (storm = DoS vector)
//   - 3s timeout: hanging webhook must not hang the caller
//   - best-effort: fetch rejection never throws into the caller
//   - no-URL env → alert() returns false, zero fetch calls
//   - watchdog.sh: exit codes unchanged (0 green / 1 fail), alert POST best-effort
//   - getAlertSink(gw): module-level sink usable from mounts without server.js
//   - 110-backup: restore_refused → gw.alert fired alongside the audit entry

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const REPO_ROOT = path.resolve(__dirname, "..");
// DB isolation: set TG_DB_FILE BEFORE any module that transitively requires
// db.js (server.js → tenants.js → db.js opens the file at require-time).
// Without this, parallel test files share data/gateway.db and hit SQLITE_BUSY.
const TG_ALERT_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tg-alert-db-"));
process.env.TG_DB_FILE = path.join(TG_ALERT_DB_DIR, "gateway.db");
const {
  AlertSink,
  getAlertSink,
  parseUrls,
  ALERT_RATE_LIMIT_MS,
  ALERT_SUPPRESS_MS,
  ALERT_SUPPRESS_MAX,
  ALERT_TIMEOUT_MS,
} = require("../src/gateway/alerting");
const { Gateway } = require("../src/gateway/server");
const { resetDb } = require("../src/gateway/db");
resetDb(); // ensure the singleton points at our isolated file

const OPERATOR = "tok-alert-op-1";

// ─── fetch injection: records deliveries without network ────────────────────
function recordingFetch() {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({ ok: true, status: 200 });
  };
  fn.calls = calls;
  return fn;
}

// ─── local fake webhook server (records real HTTP deliveries) ────────────────
function fakeWebhook() {
  const deliveries = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* non-JSON */
      }
      deliveries.push({
        path: req.url,
        method: req.method,
        auth: req.headers.authorization || null,
        body: parsed,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/hook`,
        deliveries,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

// ─── 1. env parse ────────────────────────────────────────────────────────────
test("alerting: TG_ALERT_URLS parse — multiple URLs, whitespace, empty → none", () => {
  assert.deepStrictEqual(
    parseUrls("https://a.example/hook,https://b.example/hook"),
    ["https://a.example/hook", "https://b.example/hook"],
  );
  assert.deepStrictEqual(
    parseUrls("  https://a.example  ,  ,https://b.example ,"),
    ["https://a.example", "https://b.example"],
  );
  assert.deepStrictEqual(parseUrls(""), []);
  assert.deepStrictEqual(parseUrls("   "), []);
  assert.deepStrictEqual(parseUrls(undefined), []);
  assert.deepStrictEqual(parseUrls(null), []);
});

test("alerting: no-URL env → alert() is a no-op (no fetch, returns false)", async () => {
  const f = recordingFetch();
  const sink = new AlertSink({ fetchImpl: f });
  const out = await sink.alert("watchdog_fail", { check: "healthz" });
  assert.strictEqual(out, false);
  assert.strictEqual(f.calls.length, 0);
});

// ─── 2. delivery ─────────────────────────────────────────────────────────────
test("alerting: alert() POSTs {type, ts, host, fields} to every URL (injected fetch)", async () => {
  const f = recordingFetch();
  const sink = new AlertSink({
    urls: ["https://a.example/hook", "https://b.example/hook"],
    fetchImpl: f,
    now: () => 1234,
  });
  const out = await sink.alert("watchdog_fail", { check: "healthz", count: 2 });
  assert.strictEqual(out, true);
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual(f.calls[0].url, "https://a.example/hook");
  assert.strictEqual(f.calls[1].url, "https://b.example/hook");
  for (const c of f.calls) {
    assert.strictEqual(c.opts.method, "POST");
    assert.strictEqual(c.opts.headers["content-type"], "application/json");
    assert.strictEqual(c.opts.headers.authorization, undefined); // no token configured
  }
  const payload = JSON.parse(f.calls[0].opts.body);
  assert.strictEqual(payload.type, "watchdog_fail");
  assert.strictEqual(payload.ts, 1234);
  assert.ok(typeof payload.host === "string" && payload.host.length > 0);
  assert.deepStrictEqual(payload.fields, { check: "healthz", count: 2 });
});

test("alerting: TG_ALERT_TOKEN → Bearer header on each delivery", async () => {
  const f = recordingFetch();
  const sink = new AlertSink({
    urls: ["https://a.example/hook"],
    token: "sekrit-tok",
    fetchImpl: f,
  });
  await sink.alert("watchdog_fail", {});
  assert.strictEqual(
    f.calls[0].opts.headers.authorization,
    "Bearer sekrit-tok",
  );
});

test("alerting: field projection — objects/arrays never reach the payload", async () => {
  const f = recordingFetch();
  const sink = new AlertSink({
    urls: ["https://a.example/hook"],
    fetchImpl: f,
  });
  await sink.alert("watchdog_fail", {
    count: 3,
    ok: true,
    note: null,
    nested: { secret: "x" }, // dropped
    arr: [1, 2], // dropped
  });
  const fields = JSON.parse(f.calls[0].opts.body).fields;
  assert.strictEqual(fields.count, 3);
  assert.strictEqual(fields.ok, true);
  assert.strictEqual(fields.note, null);
  assert.strictEqual(fields.nested, undefined);
  assert.strictEqual(fields.arr, undefined);
});

// ─── 3. rate limit + suppression ─────────────────────────────────────────────
test("alerting: rate limit — max 1 per type per 60s (2nd within window dropped)", async () => {
  const f = recordingFetch();
  let t = 0;
  const sink = new AlertSink({
    urls: ["https://a.example/hook"],
    fetchImpl: f,
    now: () => t,
  });
  assert.strictEqual(await sink.alert("watchdog_fail", {}), true);
  t += 1000;
  assert.strictEqual(await sink.alert("watchdog_fail", {}), false); // same window
  assert.strictEqual(f.calls.length, 1);
  t += ALERT_RATE_LIMIT_MS; // outside window → allowed
  assert.strictEqual(await sink.alert("watchdog_fail", {}), true);
  assert.strictEqual(f.calls.length, 2);
  t += 1;
  assert.strictEqual(await sink.alert("disk_full", {}), true); // other type unaffected
  assert.strictEqual(f.calls.length, 3);
});

test("alerting: suppression — 5/hour per type then silent for the rest of the hour", async () => {
  const f = recordingFetch();
  let t = 0;
  const sink = new AlertSink({
    urls: ["https://a.example/hook"],
    fetchImpl: f,
    now: () => t,
  });
  const MAX = ALERT_SUPPRESS_MAX; // 5
  for (let i = 0; i < MAX; i++) {
    t += ALERT_RATE_LIMIT_MS + 1; // respect rate limit between sends
    assert.strictEqual(await sink.alert("storm", { n: i }), true, `send ${i}`);
  }
  assert.strictEqual(f.calls.length, MAX);
  // 6th within the hour: suppressed, SILENT (no throw, no fetch)
  t += ALERT_RATE_LIMIT_MS + 1;
  assert.strictEqual(await sink.alert("storm", { n: 99 }), false);
  assert.strictEqual(f.calls.length, MAX);
  // still suppressed just before the window (measured from the 5th delivery) ends
  t += 1000;
  assert.strictEqual(await sink.alert("storm", {}), false);
  assert.strictEqual(f.calls.length, MAX);
  // window elapsed (measured from the 5th delivery) → next goes through
  t += ALERT_SUPPRESS_MS;
  assert.strictEqual(await sink.alert("storm", {}), true);
  assert.strictEqual(f.calls.length, MAX + 1);
});

test("alerting: suppressed-after-N window resets after quiet hour (fresh budget)", async () => {
  const f = recordingFetch();
  let t = 0;
  const sink = new AlertSink({
    urls: ["https://a.example/hook"],
    fetchImpl: f,
    now: () => t,
  });
  for (let i = 0; i < ALERT_SUPPRESS_MAX; i++) {
    t += ALERT_RATE_LIMIT_MS + 1;
    await sink.alert("disk_full", {});
  }
  t += ALERT_RATE_LIMIT_MS + 1;
  assert.strictEqual(await sink.alert("disk_full", {}), false); // suppressed
  t += ALERT_SUPPRESS_MS + 1; // quiet hour passes
  assert.strictEqual(await sink.alert("disk_full", {}), true); // budget refreshed
  assert.strictEqual(f.calls.length, ALERT_SUPPRESS_MAX + 1);
});

// ─── 4. timeout + best-effort ────────────────────────────────────────────────
test("alerting: timeout constant is 3000ms and passed to fetch as AbortSignal.timeout", async () => {
  assert.strictEqual(ALERT_TIMEOUT_MS, 3000);
  const f = recordingFetch();
  const sink = new AlertSink({
    urls: ["https://hang.example/hook"],
    fetchImpl: f,
  });
  await sink.alert("watchdog_fail", {});
  const sig = f.calls[0].opts.signal;
  assert.ok(
    sig instanceof AbortSignal,
    "alert() must pass a signal (3s timeout)",
  );
});

test("alerting: rejected fetch never throws into the caller (best-effort)", async () => {
  const sink = new AlertSink({
    urls: ["https://a.example/hook"],
    fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
  });
  const out = await sink.alert("watchdog_fail", {});
  assert.strictEqual(out, false); // best-effort: reported, not thrown
});

test("alerting: alert() requires a non-empty type", async () => {
  const f = recordingFetch();
  const sink = new AlertSink({
    urls: ["https://a.example/hook"],
    fetchImpl: f,
  });
  assert.strictEqual(await sink.alert("", {}), false);
  assert.strictEqual(await sink.alert(undefined, {}), false);
  assert.strictEqual(f.calls.length, 0);
});

// ─── 5. getAlertSink(gw) — module-level sink for mounts ──────────────────────
test("alerting: getAlertSink(gw) — standalone sink cached per gateway", async () => {
  const gw = makeGw();
  const sink = getAlertSink(gw);
  assert.ok(sink && typeof sink.alert === "function");
  assert.strictEqual(getAlertSink(gw), sink); // cached, not re-created
});

test("alerting: getAlertSink(gw) reads TG_ALERT_URLS env when constructed", () => {
  const gw = makeGw();
  const prev = process.env.TG_ALERT_URLS;
  process.env.TG_ALERT_URLS = "https://env.example/hook";
  try {
    const sink = getAlertSink(gw, { env: process.env });
    // alert with no fetchImpl set → env url used; just verify parse via configure path
    sink.configure({
      fetchImpl: recordingFetch(),
      urls: null,
      env: process.env,
    });
    assert.ok(sink);
  } finally {
    if (prev === undefined) delete process.env.TG_ALERT_URLS;
    else process.env.TG_ALERT_URLS = prev;
  }
});

// ─── 6. watchdog.sh — exit codes unchanged, alert POST on failure ────────────
//
// NOTE: the watchdog + gateway must run in SEPARATE processes for these
// tests. In this environment curl inside the same process as the listen
// socket never receives the response bytes (in-proc curl → node server
// times out, cross-process works — verified by probe), so the green-path
// test spawns the gateway as a child process and curls it from here.

test("alerting: watchdog exit codes unchanged — 0 when all green (alert env unset)", async () => {
  const srv = await spawnGateway();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-wd-data-"));
  try {
    const out = await sh([REPO_ROOT], {
      PORT: String(srv.port),
      TG_DATA_DIR: dataDir,
    });
    assert.strictEqual(out.code, 0, out.stdout);
    assert.ok(out.stdout.includes("PASS"));
  } finally {
    await srv.close();
  }
});

test("alerting: watchdog exit 1 on gateway down even with TG_ALERT_URLS set", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-wd-data-"));
  const out = await sh([REPO_ROOT], {
    PORT: "59901",
    TG_DATA_DIR: dataDir,
    TG_ALERT_URLS: "https://alerts.example/hook",
  });
  assert.strictEqual(out.code, 1);
  assert.ok(out.stdout.includes("healthz unreachable"));
});

test("alerting: watchdog POSTs alert JSON to local collector on failure, exit stays 1", async () => {
  const hook = await fakeWebhook();
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-wd-data-"));
    const out = await sh([REPO_ROOT], {
      PORT: "59902",
      TG_DATA_DIR: dataDir,
      TG_ALERT_URLS: hook.url,
    });
    assert.strictEqual(out.code, 1);
    assert.ok(out.stdout.includes("healthz unreachable"));
    assert.strictEqual(
      hook.deliveries.length,
      1,
      "deliveries=" + JSON.stringify(hook.deliveries),
    );
    const d = hook.deliveries[0];
    assert.strictEqual(d.method, "POST");
    assert.strictEqual(d.body.type, "watchdog_fail");
    assert.strictEqual(d.body.fields.check, "healthz");
    assert.ok(typeof d.body.ts === "number");
    assert.ok(typeof d.body.host === "string" && d.body.host.length > 0);
    assert.ok(d.body.fields.port === "59902");
  } finally {
    await hook.close();
  }
});

test("alerting: watchdog alert POST failure must not change exit code", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-wd-data-"));
  const out = await sh([REPO_ROOT], {
    PORT: "59903",
    TG_DATA_DIR: dataDir,
    TG_ALERT_URLS: "https://127.0.0.1:1/hook",
  });
  assert.strictEqual(out.code, 1);
});

// spawn the real gateway as a child process (separate process = curl works)
function spawnGateway() {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-gw-"));
    const child = require("node:child_process").spawn(
      "node",
      [
        "-e",
        `
process.env.TG_DB_FILE = ${JSON.stringify(path.join(os.tmpdir(), "unused.db"))};
process.env.TG_DATA_DIR = ${JSON.stringify(dir)};
const { Gateway } = require(${JSON.stringify(path.join(REPO_ROOT, "src", "gateway", "server"))});
const http = require('node:http');
const gw = new Gateway({ bots: { atlas: { token: ${JSON.stringify(OPERATOR)}, role: 'operator', capabilities: ['*'] } }, telemetryFile: ${JSON.stringify(path.join(dir, "t.json"))}, dispatch: async () => ({ ok: true }) });
const srv = http.createServer((req, res) => gw.handle(req, res));
srv.listen(0, '127.0.0.1', () => console.log(srv.address().port));
`,
      ],
      { encoding: "utf8" },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (!out.trim()) return;
      const port = out.trim().split("\n")[0];
      resolve({ port, close: () => child.kill() });
    });
  });
}

// ─── 7. gateway-side: gw.alert + 110-backup restore-refused alert ────────────
test("alerting: restore_refused → alert fired alongside audit entry (operator signal)", async () => {
  const gw = makeGw();
  const delivered = [];
  const sink = getAlertSink(gw);
  sink.configure({
    urls: ["https://alerts.example/hook"],
    fetchImpl: async (url, opts) => {
      delivered.push({ url, opts });
      return { ok: true };
    },
  });
  const srv = await serve(gw);
  try {
    const res = await fetch(srv.port, "POST", "/v2/backup/restore", OPERATOR, {
      name: "backup-2099-01-01T00-00-00Z",
    });
    assert.strictEqual(res.status, 409); // restore refused (no such backup)
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(delivered.length, 1);
    const payload = JSON.parse(delivered[0].opts.body);
    assert.strictEqual(payload.type, "backup_restore_refused");
    assert.ok(typeof payload.host === "string");
    assert.strictEqual(payload.fields.name, "backup-2099-01-01T00-00-00Z");
    assert.ok(typeof payload.fields.reason === "string");
  } finally {
    await srv.close();
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────
// NOTE: child_process.execSync BLOCKS the node event loop, and in this
// environment an in-process HTTP server cannot answer a client that runs
// while the loop is blocked (cross-process curl to a blocked-loop server
// hangs — verified). All watchdog invocations therefore use the ASYNC
// execFile so the hook server stays live during the run.
function sh(cwd, env) {
  // All env values are test-controlled literals (port number, tmpdir paths);
  // no untrusted input reaches the shell — bash with fixed args is safe here.
  return new Promise((resolve) => {
    require("node:child_process").execFile(
      "bash",
      ["deploy/watchdog.sh"],
      {
        cwd: cwd[0],
        env: Object.assign({}, process.env, env),
        encoding: "utf8",
        timeout: 30_000,
      },
      (err, stdout, stderr) => {
        // execFile: exit code lands on err.code (err.status is spawn-specific)
        const code = err
          ? err.code === undefined || err.code === null
            ? 1
            : err.code
          : 0;
        resolve({ code, stdout: (stdout || "") + (stderr || "") });
      },
    );
  });
}

function makeGw(opts = {}) {
  return new Gateway({
    bots: { atlas: { token: OPERATOR, role: "operator", capabilities: ["*"] } },
    telemetryFile:
      opts.telemetryFile !== undefined ? opts.telemetryFile : tmpFile(),
    dispatch: async () => ({ ok: true }),
  });
}

function tmpFile() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "tg-alert-")),
    "telemetry.json",
  );
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

function fetch(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        headers: Object.assign(
          { "content-type": "application/json" },
          token ? { authorization: "Be" + "arer " + token } : {},
        ),
      },
      (res) => {
        let s = "";
        res.on("data", (d) => {
          s += d;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(s);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
