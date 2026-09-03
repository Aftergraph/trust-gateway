'use strict';
// FS-E2 — one-shot backup entrypoint for the systemd timer (tg-backup.service)
// and for cron. Runs against the live data dir (TG_DATA_DIR or ./data) and
// prints a one-line manifest summary suitable for journalctl.
//
// GW-LESS BY DESIGN: this runs outside the gateway process, so there is no
// live audit chain in scope. We pass null for the chain — the manifest keeps
// chainHead/chainId null, exactly like createBackup()'s default. Attaching
// real chain facts stays the gateway mount's job (see src/gateway/backup.js).
//
// Exit codes: 0 = backup created and manifest written; 1 = anything failed.

const { createBackup, withChainFacts } = require('../src/gateway/backup');

try {
  // gw-less: null chain → manifest keeps chainHead: null, chainId: null
  const { dir, manifest } = withChainFacts(createBackup(), null);
  const bytes = manifest.files.reduce((n, f) => n + (f.size || 0), 0);
  console.log(
    `backup: ${dir} files=${manifest.files.length} bytes=${bytes}` +
    ` chainHead=${manifest.chainHead} createdAt=${manifest.createdAt}`
  );
  process.exitCode = 0;
} catch (e) {
  console.error(`backup-once: FAILED — ${e.message}`);
  process.exitCode = 1;
}
