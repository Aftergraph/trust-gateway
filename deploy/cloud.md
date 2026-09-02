# Deploy runbook — cloud / desktop / local-server

Trust Gateway runs from one checkout with zero npm dependencies. This runbook
covers the three deploy shapes and is honest about what is automated (nothing
is executed for you) and what is not.

Deploy mode (`detectMode()` in `src/gateway/deploy.js`) is a **heuristic
surfaced in the console UI only — never a security decision**. It reads
`TG_DEPLOY_MODE` if set (one of `desktop|cloud|local-server`), else guesses
from the environment: a systemd init (via `/proc/1/comm`) with no ssh session
(`SSH_CONNECTION` unset) looks desktop-ish, an ssh session looks cloud, and
anything else is treated as a local server. Containers, custom init systems,
and remote desktops can all misclassify; nothing authorizes or denies anything
based on it.

---

## 1. Desktop mode (PWA install)

The console is a PWA. Install it from the browser and it gets its own window,
icon, and launcher entry:

1. Start the gateway (see §3 for a managed service, or just `node bin/gateway.js`).
2. Open the console URL (default `http://127.0.0.1:8787`).
3. Install per platform:
   - **Linux:** use the generated launcher — GET
     `/v2/deploy/artifact?kind=launcher` (bearer) returns a `.desktop` entry.
     Save it to `~/.local/share/applications/trust-gateway.desktop` and run
     `update-desktop-database ~/.local/share/applications`. That `.desktop`
     file is the **only generated artifact**; for Windows/macOS use the manual
     steps below (nothing is generated for those platforms).
   - **Windows:** Chrome/Edge → menu ⋮ → "Cast, save and share" → "Install
     page as app". Start-menu shortcut is created automatically.
   - **macOS:** Chrome → "Install Page as App", or Safari 14+ → File →
     "Add to Dock…" with "Open as window" ticked.

## 2. Desktop access without port forwarding (tailscale)

Do not expose the gateway to the public internet. Tailscale gives you a
private route from your other devices without opening any router ports:

```sh
# on the gateway machine (once):
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# expose HTTPS to your tailnet only (no port forwarding anywhere):
tailscale serve --bg --https=443 http://127.0.0.1:8787

# optional, when you truly need access from outside the tailnet:
tailscale funnel 443 on   # PUBLIC by design — prefer serve; turn it off after
```

`tailscale serve` keeps the gateway reachable only inside your tailnet.
`funnel` puts it on the public internet — treat it as an exception with an
expiry, not a setup.

## 3. systemd user-level service (Linux)

The gateway ships a static template (`deploy/systemd.service`) and renders a
filled-in copy on demand:

- Template: committed placeholders only (`TG_BOT_TOKENS__SET_ME`, …). Every
  operator-editable spot ends in `__SET_ME`.
- Rendered copy: `GET /v2/deploy/artifact?kind=service` (bearer) — same unit
  with your `PORT` / `EnvironmentFile` baked in. Every render is audited as
  `deploy_artifact` in the chain.

Install steps (as your user; **never** with sudo/system-level):

```sh
mkdir -p ~/.config/systemd/user
cp deploy/systemd.service ~/.config/systemd/user/trust-gateway.service
$EDITOR ~/.config/systemd/user/trust-gateway.service   # fix WorkingDirectory + EnvironmentFile path
systemctl --user daemon-reload
systemctl --user enable --now trust-gateway.service
journalctl --user -u trust-gateway.service -f
loginctl enable-linger $USER   # keep it alive after logout
```

Secrets live in the `EnvironmentFile` (default `data/gateway.env`). `data/`
is gitignored, so the env file never enters git. The template ships a
placeholder pattern, not real values — you write the file yourself:

```sh
cat > data/gateway.env <<'EOF'
TG_BOT_TOKENS=atlas:your-real-token-here
TG_LLM_BASE_URL=https://api.example.com/v1
TG_LLM_KEY=sk-your-real-key
# TG_TTS_URL=https://api.example.com/v1/audio/speech
EOF
chmod 600 data/gateway.env
```

The gateway must not be started as root; a user unit plus `ReadWritePaths`
(see hardening block in the unit) confines writes to `data/`.

## 4. VPS / cloud checklist

- **Firewall:** `ufw default deny incoming; ufw allow OpenSSH; ufw allow in on tailscale0; ufw enable`
  — the gateway port stays unreachable from the public internet; only your
  tailnet (tailscale0 interface) and ssh can reach the box.
- **Backups of `data/`:** the chain is a live SQLite DB — do **not** `cp` the
  live `data/gateway.db` (you can catch it mid-write). Use the SQLite online
  backup API:
  ```sh
  node -e 'const {DatabaseSync}=require("node:sqlite");const s=new DatabaseSync("data/gateway.db");const d=new DatabaseSync("/var/backups/gateway-"+Date.now()+".db");s.backup(d);d.close();s.close()'
  ```
  Copy the JSONL side files (approvals, artifacts) at rest after the DB
  snapshot; they are small and written atomically.
- **Rotate bot tokens:** tokens live only in `data/gateway.env` (gitignored).
  Rotate on any suspicion: edit the file, `systemctl --user restart
  trust-gateway`. Old tokens die with the restart; the chain keeps an
  `auth_rejected` trail for the old ones.
- **Log hygiene:** `gateway.log` is gitignored (`.gitignore` lists it — this
  is intentional and tested). Under systemd, stdout goes to the journal
  instead (`journalctl --user -u trust-gateway`); redirecting to a file is
  your choice, but keep that file out of git too.
- **Updates:** `git pull && systemctl --user restart trust-gateway`. Zero
  dependencies means no `npm install` step, ever.

## 5. Explicit non-goals

- **No auto-deploy execution.** The gateway renders artifacts and reports
  status. It never runs `systemctl`, never installs units, never enables
  services, never writes outside `data/` for deploy purposes. A human runs
  every install command.
- **No secrets in the repo.** Bot tokens, `TG_LLM_KEY`, and friends exist only
  in gitignored `data/` files. Rendered artifacts use `__SET_ME` placeholders;
  `statusReport` returns booleans for env-set flags, never values.
- **No public exposure by default.** Nothing in this repo opens ports, and the
  runbook steers toward tailnet-only access.