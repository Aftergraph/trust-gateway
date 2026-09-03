'use strict';
// FS-F3 sandbox hardening spike — OPTIONAL OS-level isolation for the
// harness2 jailed build/run loop, with HONEST detection and graceful
// degradation.
//
// What the jail is today (see harness2.js header): same-user directory
// discipline — process hygiene only (no shell, scrubbed env, 10 s SIGKILL,
// output tails). A malicious entry can still reach anything the gateway
// user can. This module adds an OPTIONAL second layer using OS primitives
// when they exist:
//
//   bwrap    (bubblewrap) — the full layer: private tmpfs /tmp, bind-mounts
//            limited to the project jail (read-only) + the node binary +
//            the minimum shared-library dirs measured on the reference VDS
//            (/usr/lib, /usr/lib64, /lib + the /lib64 loader link), network
//            namespace removed unless opts.network === true.
//   unshare   — a WEAKER layer: user+mount+net+pid namespaces via
//            `unshare --user --map-root-user …` (child drops to a mapped
//            non-root uid; no private /tmp, no path pinning). Honest: this
//            isolates network/processes, NOT the filesystem.
//   systemd-run — DETECTED ONLY. Wrapping through a transient systemd unit
//            needs a reachable bus and a unit-management policy; the spike
//            measures availability but does not wrap with it. Recorded so
//            operators can see what a future iteration could build on.
//
// HONEST DETECTION: detectSandboxSupport() runs real probes (`which`,
// `unshare --user --map-root-user true`) with hard timeouts and returns
// booleans + the probe errors. No assumptions about the host; a VDS without
// user namespaces reports unshare:false, not a guess.
//
// GRACEFUL DEGRADATION: when NOTHING is available, wrapCommand() returns
// the command UNWRAPPED ({wrapped:false, reason}). Unwrapped = the current
// same-user discipline described above — callers fall back byte-identically
// to the pre-FS-F3 behavior. The layer is strictly additive.
//
// Wiring: harness2 build/run only touch this when TG_SANDBOX=1 (default
// off → byte-identical behavior, zero new audit rows). With it on, every
// run emits `sandbox_used` {id, method: bwrap|unshare|none} and, when a
// wrap attempt fails at runtime, `sandbox_fallback` {id, reason} before the
// unwrapped retry. Payloads never contain argv, paths, or file contents.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const PROBE_TIMEOUT_MS = 5_000;

let cached = null; // detection memo; clearSandboxCache() resets (tests)

function probe(argv, label, errors) {
  try {
    const r = spawnSync(argv[0], argv.slice(1), {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (r.error) {
      errors.push(`${label}: ${String(r.error.code || r.error.message).slice(0, 120)}`);
      return false;
    }
    if (r.status !== 0) {
      const errText = String(r.stderr || '').trim().split('\n')[0].slice(0, 120);
      errors.push(`${label}: exit ${r.status}${errText ? ` (${errText})` : ''}`);
      return false;
    }
    return true;
  } catch (e) {
    errors.push(`${label}: ${String(e && e.message).slice(0, 120)}`);
    return false;
  }
}

function detectSandboxSupport() {
  if (cached) return cached;
  const probeErrors = [];

  // (a) bwrap on PATH — `which bwrap` exit 0. A found binary is further
  // exercised at wrap time; the runtime fallback in harness2.js covers a
  // binary that exists but cannot create its sandbox (e.g. setuid denied).
  const bwrapWhich = probe(['which', 'bwrap'], 'bwrap:which', probeErrors);
  const bwrap = bwrapWhich;

  // (b) unshare with user-namespace support — the kernel rejects the ns
  // even when the binary exists, so probe the real thing.
  const unshare = probe(
    ['unshare', '--user', '--map-root-user', 'true'],
    'unshare:userns',
    probeErrors,
  );

  // (c) systemd-run availability (detected only — see header).
  const systemdRun = probe(['which', 'systemd-run'], 'systemd-run:which', probeErrors);

  cached = { bwrap, unshare, systemdRun, probeErrors };
  return cached;
}

function clearSandboxCache() { cached = null; }

// Shared-library dirs the dynamic loader needs inside the bwrap mount ns.
// Measured on the reference host: node (dynamically linked) needs
// /usr/lib + the /lib64 loader link; /lib exists on Debian-family hosts.
// Each bind is included only when the dir exists on THIS host.
function libBinds() {
  const binds = [];
  for (const d of ['/usr/lib', '/usr/lib64', '/lib']) {
    if (fs.existsSync(d)) binds.push('--ro-bind', d, d);
  }
  // On Debian/Ubuntu /lib64 is a symlink to usr/lib64; bind the target as
  // a mount point and recreate the link so the loader path resolves.
  try {
    if (fs.lstatSync('/lib64').isSymbolicLink()) {
      binds.push('--symlink', 'usr/lib64', '/lib64');
    } else if (fs.existsSync('/lib64')) {
      binds.push('--ro-bind', '/lib64', '/lib64');
    }
  } catch { /* no /lib64 — loader must come from the binds above */ }
  return binds;
}

function scrubEnv(base) {
  return {
    PATH: (base && base.PATH) || process.env.PATH || '/usr/bin:/bin',
    HOME: (base && base.HOME) || process.env.HOME || '/tmp',
    NODE_ENV: (base && base.NODE_ENV) || 'production',
  };
}

/**
 * Optionally wrap a jailed command in an OS-level sandbox.
 *
 * @param {string} cmd   e.g. 'node'
 * @param {string[]} args  e.g. [entryAbs]
 * @param {{ jail?: string, network?: boolean, env?: object,
 *           support?: {bwrap?:boolean, unshare?:boolean, systemdRun?:boolean} }} opts
 *   jail      — project jail dir bound read-only into the sandbox
 *   network   — true keeps the host network namespace (default: removed)
 *   support   — test/override hook; default is real host detection
 * @returns {{cmd: string, args: string[], env: object,
 *            wrapped: boolean, method: 'bwrap'|'unshare'|'none',
 *            reason?: string}}
 */
function wrapCommand(cmd, args, opts = {}) {
  const support = opts.support || detectSandboxSupport();
  const env = scrubEnv(opts.env);

  if (support.bwrap) {
    // Resolve the executor NOW so the bind target is the real binary, not
    // a PATH lookup that would fail inside the sandbox (execvp has no PATH
    // entry for node once only the jail + node dir are mounted).
    let nodeBin;
    try { nodeBin = fs.realpathSync(cmd === 'node' ? process.execPath : cmd); } catch { nodeBin = null; }
    if (nodeBin && opts.jail) {
      const jail = opts.jail;
      const argv = [
        '--dev', '/dev',
        '--proc', '/proc',
        '--tmpfs', '/tmp', // private tmp — the host /tmp is not visible
        ...libBinds(),
        '--ro-bind', nodeBin, nodeBin, // the node binary, nothing else of PATH
        '--ro-bind', jail, jail, // the jail, read-only: run only reads it
        '--chdir', jail,
        '--die-with-parent',
      ];
      if (opts.network !== true) argv.push('--unshare-net');
      argv.push('--', nodeBin, ...args);
      return { cmd: 'bwrap', args: argv, env, wrapped: true, method: 'bwrap' };
    }
    // bwrap exists but the invocation cannot be pinned (no jail or
    // unresolvable executor) — fall through honestly.
  }

  if (support.unshare) {
    // Weaker layer (see header): user+mount+net+pid namespaces; the child
    // runs as a mapped non-root uid. No private /tmp, no path pinning —
    // documented, not hidden.
    const argv = ['--user', '--map-root-user', '--mount', '--pid', '--fork'];
    if (opts.network !== true) argv.push('--net');
    argv.push('--', cmd, ...args);
    return { cmd: 'unshare', args: argv, env, wrapped: true, method: 'unshare' };
  }

  // Nothing available → the current same-user discipline, byte-identical.
  return {
    cmd, args, env, wrapped: false, method: 'none',
    reason: 'no_os_sandbox_available',
  };
}

module.exports = {
  detectSandboxSupport, clearSandboxCache, wrapCommand, scrubEnv,
  PROBE_TIMEOUT_MS,
};
