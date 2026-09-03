# Self-hosting Trust Gateway

This guide covers installing, configuring, operating, upgrading, and removing
Trust Gateway on your own Linux machine. It assumes you want the systemd
deployment (the supported production path) with the per-bot jailed dispatcher
enabled.

Everything below references files that exist in this repository. The gateway
has zero npm runtime dependencies — the full test suite runs on Node core
alone.

## Prerequisites

- Linux with systemd (system-level units; a root login or `sudo`).
- Node.js 24+ (`node --version`). The repo declares `>=20`; 24 is the
  supported line for production.
- Port 8800 free (or another port of your choosing — see Configuration).
- `git`, `curl`, and `bash`.
- Root or sudo for `/etc/systemd/system` (the installer refuses to run
  otherwise).

## Quickstart

```bash
# 1. Clone
git clone <your-fork-url> trust-gateway && cd trust-gateway
npm test                      # 1028+ tests, node core only — sanity gate

# 2. Write your env file. data/ is gitignored — secrets never enter git.
mkdir -p data
cat > data/gateway.env <<'EOF'
# What bin/gateway.js actually reads (systemd unit execs it directly):
BOT_TOKENS=atlas:your-operator-token,forge:your-worker-token
# Optional — see Configuration below for every variable:
# BOT_CAPS={"forge":["fs.read","web.get"]}
# BOT_ROLES={"forge":"worker"}
# PORT=8800
EOF
chmod 600 data/gateway.env

# 3. Install the systemd unit (idempotent; rewrites paths to THIS clone)
sudo bash deploy/install.sh

# 4. Verify health
curl -s http://127.0.0.1:8800/healthz | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)))'
# Expect: {"ok":true,"chain":{...},"length":N,...}
```

The installer fails closed: it refuses to run without the env file, without
node, without root, and it gates success on `/healthz` answering `ok:true`
within 30 seconds. It is safe to re-run (overwrite, never duplicate).

Create your tokens yourself, on your machine. Use long random strings
(`openssl rand -hex 24`). `atlas` is the operator role by default (may
approve/deny); every other bot is a worker that fails closed on approval
endpoints.

Note on `--dispatch`: the production unit runs
`node bin/gateway.js --dispatch`, which enables the per-bot jailed
dispatcher — each bot gets its own directory under `data/bots/`.

## Configuration

`data/gateway.env` is read by two consumers. Be exact about which names each
reads:

1. **`bin/gateway.js`** — reads these *unprefixed* names directly (verified
   against the source). The systemd unit execs it, so its EnvironmentFile
   must define at least `BOT_TOKENS`:

   | Variable | Default | Meaning |
   |---|---|---|
   | `BOT_TOKENS` | — (required) | Comma-separated `name:token` pairs, e.g. `atlas:s3cret,forge:op-s3cret`. Empty/absent → the gateway exits 1. |
   | `BOT_CAPS` | `{}` | Per-bot capabilities JSON: `{"forge":["fs.read","fs.write:*"]}`. A bot with no entry gets `["fs.read","web.get"]`. |
   | `BOT_ROLES` | `{}` | Role override JSON map. Default: `atlas` → `operator`, everyone else → `worker`. Workers fail closed on approval endpoints. |
   | `PORT` | `8800` | HTTP listen port. |
   | `AUDIT_FILE` | `data/audit.jsonl` | JSONL audit chain file (used only when `DB_FILE` does not exist). |
   | `APPROVALS_FILE` | `data/approvals.json` | Durable approvals store. |
   | `DB_FILE` | `data/gateway.db` | SQLite chain DB. If the file exists, the gateway uses SqlChain storage (v2) instead of JSONL. |
   | `STATIC_DIR` | `app/` | Operator console static assets. |
   | `BOTS_DIR` | `data/bots` | Root under which per-bot jailed dirs are created (dispatcher mode). |
   | `V2_SQL` | on | Set to `0` to force JSONL audit even when `DB_FILE` exists. |

2. **`TG_`-prefixed names** — read by the ops scripts, not by `bin/gateway.js`:

   | Variable | Read by | Meaning |
   |---|---|---|
   | `TG_BOT_TOKENS`, `TG_BOT_CAPS`, `TG_BOT_ROLES`, `TG_PORT` | `scripts/gateway-start.sh` (manual start), `deploy/status.sh` (port only) | Prefixed aliases of the four core variables. The script translates them to the unprefixed names before exec. Keep both sets in `gateway.env` if you use that script. |
   | `TG_LLM_BASE_URL` | LLM brain | OpenAI-compatible base URL for the chat/LLM brain. Unset → chat runs without a model backend. |
   | `TG_LLM_KEY` | LLM brain | Bearer key. Never logged, never audited, never echoed. |
   | `TG_LLM_MODEL` | LLM brain | Model id. |
   | `TG_ALERT_URLS` | `deploy/watchdog.sh` (and the in-gateway alerting sink) | Comma-separated webhook URLs; watchdog failures are POSTed as JSON (best-effort, never changes exit code). |
   | `TG_ALERT_TOKEN` | `deploy/watchdog.sh` | Optional Bearer token for the webhook POST. |
   | `TG_DISK_MAX_PCT` | `deploy/watchdog.sh` | Disk-full threshold, default `90` (%). |
   | `TG_DATA_DIR` | `deploy/watchdog.sh`, backup tooling | Data dir, default `<repo>/data`. |

Rotation: edit `data/gateway.env`, then `sudo systemctl restart tg-gateway`.
Old tokens die with the restart; rejected attempts land in the audit chain.

## Daily operations

```bash
systemctl status tg-gateway          # active/failed, PID, restarts
curl -s http://127.0.0.1:8800/healthz
bash deploy/status.sh                # human summary (SEALS + pending)
journalctl -u tg-gateway -f          # live logs
```

### Watchdog + alerts

`deploy/watchdog.sh` probes three hard signals — `/healthz` answers
`ok:true`, the audit chain verifies, and the data-dir disk usage is under
`TG_DISK_MAX_PCT` — and exits nonzero on the first failure. When
`TG_ALERT_URLS` is set it also POSTs the failure as JSON to each URL
(5s max per URL; a broken webhook can never change the exit code or leak
secrets — payload carries check name, detail, port, hostname, timestamp).

Wire it into systemd as an `OnFailure=` unit or a cron line, e.g.:

```bash
# /etc/cron.d/tg-watchdog  — every minute
* * * * * root TG_ALERT_URLS=https://hooks.example.invalid/tg bash /path/to/trust-gateway/deploy/watchdog.sh
```

### Backups

```bash
sudo cp deploy/backup-timer/tg-backup.service /etc/systemd/system/
sudo cp deploy/backup-timer/tg-backup.timer  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-backup.timer
systemctl list-timers tg-backup.timer   # verify next 04:00 fire
```

The timer fires `bin/backup-once.js` daily at 04:00 (`Persistent=true`
catches up a missed run). Backups land in `data/backups/` with per-file
sha256 manifests (FIFO, newest last, 10 kept).

### Restore drill

Run the drill **before** you need it — it proves the restore machinery
fails closed on a deliberately corrupt backup without touching live data:

```bash
bash deploy/restore-drill.sh
```

The real restore path (`POST /v2/backup/restore`) verifies every sha256
before replacing anything and refuses (409) on any mismatch. Full verified
procedure: [RUNBOOK.md §Failure mode 4](RUNBOOK.md).

## Failure modes

The runbook covers all four with measured behavior (chaos-tested on this
codebase, not aspirational):

- [RUNBOOK.md §Failure mode 1 — chain verify fails](RUNBOOK.md): stop the
  gateway first; the chain is the evidence trail, not something to self-heal.
- [RUNBOOK.md §Failure mode 2 — disk full](RUNBOOK.md): audit append under
  ENOSPC kills the process — fail-closed, no partial entry.
- [RUNBOOK.md §Failure mode 3 — gateway crash-loops](RUNBOOK.md): read the
  actual journalctl error; two gateways on one DB file is not supported.
- [RUNBOOK.md §Failure mode 4 — restore needed](RUNBOOK.md): verified
  restore procedure.

## Upgrading

```bash
cd /path/to/trust-gateway
git pull
npm test                 # suite must be green BEFORE restarting
sudo systemctl restart tg-gateway
curl -s http://127.0.0.1:8800/healthz   # ok:true again
```

Chain-safety note: restarts are safe — the chain verifies on boot and on
shutdown, and a trailing partial line from a crash is dropped and rewritten
by disk-audit. But never run `git pull` + restart while the audit chain
fails verification: stop the gateway and resolve per RUNBOOK §Failure mode 1
first, so you don't seal new entries onto a broken chain.

## Uninstall

```bash
sudo systemctl disable --now tg-gateway.service
sudo systemctl disable --now tg-backup.timer 2>/dev/null || true
sudo systemctl stop tg-backup.service 2>/dev/null || true
sudo rm /etc/systemd/system/tg-gateway.service
sudo rm -f /etc/systemd/system/tg-backup.service /etc/systemd/system/tg-backup.timer
sudo systemctl daemon-reload
```

**WARNING — data destruction.** `data/` holds the audit chain
(`data/gateway.db` / `data/audit.jsonl`), approvals, and all backups
(`data/backups/`). Deleting it destroys the tamper-evident evidence trail
permanently. Export `data/backups/` somewhere off-box before:

```bash
sudo rm -rf /path/to/trust-gateway/data
```
