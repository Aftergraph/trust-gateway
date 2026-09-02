'use strict';
// Trust Gateway v2 — Self-repair: SAFE DIAGNOSIS + ISOLATION. W10.
//
// What "repair" means here — and what it must NEVER mean:
//   The audit chain's entire value is tamper-evidence. A chain that fails
//   verification has either been tampered with or corrupted; re-sealing the
//   hashes ("fixing" them silently) would destroy exactly the evidence the
//   chain exists to produce, and would turn a breach into a cover-up. So:
//
//     REPAIR = detect → locate the failed seq → compare DB rows against any
//     in-memory expected copy → write a QUARANTINE COPY of the full chain
//     snapshot (data/quarantine-<ts>.json, atomic + 0600) → audit
//     selfrepair_diagnosed {at, reason, quarantined:true} → answer 503.
//
//     It never mutates, re-hashes, truncates, or overwrites chain entries.
//     Recovery from quarantine is a human decision, on the record.
//
// Zero deps, node built-ins only.

const fs = require('node:fs');
const path = require('node:path');
const { entryHash } = require('./hash-chain');

const REPO_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

function summarizeEntry(e) {
  return {
    seq: e.seq,
    ts: e.ts,
    prevHash: e.prevHash,
    hash: e.hash,
    payload: e.payload,
  };
}

class SelfRepair {
  /**
   * @param {object} opts
   * @param {object} opts.gw            Gateway (uses gw.chain, gw._audit).
   * @param {string} [opts.dataDir]     Where quarantine files land. Default:
   *                                    the directory of a file-backed chain,
   *                                    else TG_QUARANTINE_DIR, else repo data/.
   * @param {Function} [opts.now]
   * @param {Array}    [opts.expected]  Optional in-memory expected entries
   *                                    (mirror), compared to DB rows when the
   *                                    host keeps one. gw.chainMemory works too.
   */
  constructor({ gw, dataDir = null, now = (gw && gw.now) || (() => Date.now()), expected = null } = {}) {
    if (!gw || !gw.chain || typeof gw.chain.verify !== 'function')
      throw new Error('SelfRepair: requires a gateway with a verifiable chain');
    this.gw = gw;
    this.now = now;
    this.expected = expected;
    this.dataDir = dataDir
      || (gw.chain.file ? path.dirname(gw.chain.file) : null)
      || process.env.TG_QUARANTINE_DIR
      || REPO_DATA_DIR;
  }

  // Compare the stored rows against an in-memory expected mirror, where
  // available. Returns null when the host keeps no mirror (SqlChain alone).
  _compare(entries) {
    const expectedList = this.expected || (this.gw && this.gw.chainMemory) || null;
    if (!Array.isArray(expectedList)) {
      return { hasInMemoryExpected: false, mismatches: [] };
    }
    const mismatches = [];
    for (const e of entries) {
      const exp = expectedList.find((x) => x && x.seq === e.seq);
      if (!exp) { mismatches.push({ seq: e.seq, kind: 'missing_in_expected' }); continue; }
      if (exp.hash !== e.hash) {
        mismatches.push({
          seq: e.seq,
          kind: JSON.stringify(exp.payload) !== JSON.stringify(e.payload) ? 'payload_changed' : 'hash_only_changed',
          storedHash: e.hash,
          expectedHash: exp.hash,
        });
      }
    }
    return { hasInMemoryExpected: true, mismatches };
  }

  _quarantineFile(ts, failedSeq) {
    let name = `quarantine-${ts}.json`;
    for (let i = 0; i < 1000; i++) {
      const candidate = path.join(this.dataDir, name);
      if (!fs.existsSync(candidate)) return { name, full: candidate };
      ts += 1; // same-ms repeats get a fresh suffix deterministically
      name = `quarantine-${ts}.json`;
    }
    throw new Error('selfrepair: quarantine name collision storm');
  }

  /**
   * Read-only diagnosis of the audit chain. On tamper: quarantine + audit +
   * report (the mount turns `ok:false` into 503).
   */
  diagnose() {
    const chain = this.gw.chain;
    const v = chain.verify();
    if (v.ok) {
      return {
        ok: true,
        repaired: false,
        verified: true,
        length: v.length,
        head: v.head,
        chainId: v.chainId,
        note: 'chain sealed; nothing to diagnose',
      };
    }

    const failedSeq = v.at;
    const reason = v.reason;
    const entries = chain.entries.map(summarizeEntry);
    const dbEntry = entries.find((e) => e.seq === failedSeq) || null;
    const prevEntry = dbEntry ? (entries.find((e) => e.seq === dbEntry.seq - 1) || null) : null;

    // Re-hash the failed row: distinguishes content tampering (stored hash
    // != recomputed hash) from link tampering (prevHash != previous row's hash).
    const recomputed = dbEntry ? entryHash(dbEntry.seq, dbEntry.prevHash, dbEntry.ts, dbEntry.payload) : null;
    const comparison = this._compare(entries);

    const report = {
      ok: false,
      repaired: false, // by design — silent re-seal would destroy tamper evidence
      verified: false,
      failedSeq,
      reason,
      chainId: v.chainId || chain.chainId || null,
      length: entries.length,
      dbFile: chain.file || null,
      diagnosis: {
        storedEntry: dbEntry,
        recomputedHash: recomputed,
        storedHashMatchesContent: dbEntry ? dbEntry.hash === recomputed : null,
        prevLinkValid: dbEntry ? (dbEntry.prevHash === (prevEntry ? prevEntry.hash : '0'.repeat(64))) : null,
        expectedComparison: comparison,
        neighbors: entries
          .filter((e) => Number.isFinite(failedSeq) && Math.abs(e.seq - (failedSeq || 0)) <= 1)
          .map(summarizeEntry),
      },
      note: 'REPAIR = safe diagnosis + isolation. No hashes were rewritten; '
          + 're-sealing a broken chain silently destroys tamper-evidence.',
    };

    // Quarantine copy: full snapshot of the chain at diagnosis time.
    const ts = this.now();
    const { name, full } = this._quarantineFile(ts, failedSeq);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      quarantinedAt: ts,
      gatewayChainId: report.chainId,
      verify: v,
      diagnosis: report.diagnosis,
      entries,
    }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, full);
    try { fs.chmodSync(full, 0o600); } catch { /* best effort */ }

    report.quarantine = name;
    report.quarantinePath = full;

    // The diagnosis itself is sealed (append still works on a broken chain —
    // we only trust `head`, never the historical hashes).
    if (typeof this.gw._audit === 'function') {
      this._quarantined = true; // re-entrancy guard not needed (own type), kept for clarity
      this.gw._audit({
        type: 'selfrepair_diagnosed',
        at: failedSeq,
        reason,
        quarantined: true,
        quarantineFile: name,
        repaired: false,
      });
    }
    return report;
  }
}

// One repairer per gateway instance (WeakMap).
const repairers = new WeakMap();
function getRepair(gw) {
  let r = repairers.get(gw);
  if (!r) { r = new SelfRepair({ gw }); repairers.set(gw, r); }
  return r;
}

module.exports = { SelfRepair, getRepair };
