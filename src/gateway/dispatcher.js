'use strict';
// Per-bot jailed filesystem dispatcher (v2 of the demo dispatcher).
//
// SECURITY NOTE / OUT OF SCOPE:
// This is NOT a security boundary against a malicious actor with code
// execution as root on the host. If an agent can run arbitrary code with
// the process's privileges, it can escape any userspace jail, replace the
// realpath syscall result, or simply chown/exit-jail of the process. This
// module is a *guardrail against agent mistakes*: it makes accidental
// path traversal or symlink escape fail closed, so a bot composing a
// file path cannot silently read/write outside its own subdirectory.
//
// Dispatch signature: dispatch(bot, tool, args) -> result
//   bot   : the bot NAME (string), e.g. "forge"
//   tool  : a tool string, e.g. "fs.read:notes/x.md", "fs.write:out.txt", "shell.run"
//   args  : { content?: string, cmd?: string } | null
// Result: an object (never throws into the audit trail; errors surface as {ok:false,error}).
//
// Jailing strategy:
//   - Each bot lives under `botsDir/<botname>/` (created lazily).
//   - For fs.read / fs.write, resolve the requested path with path.resolve
//     against the bot root, then verify the *realpath* of every existing
//     ancestor stays within the realpath of the bot root. This defeats
//     symlink escapes: a symlink inside the jail pointing to /etc/passwd
//     resolves outside and is rejected with `escapes_jail`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// realpathSync that returns undefined instead of throwing on ENOENT.
// (fs.realpathSync does NOT honor a `{ throwing: false }` option; that option
// exists only on fs.access. Wrap explicitly.)
function tryRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Build a dispatcher bound to a bots root directory.
 * @param {{ botsDir: string, shellMode?: 'echo'|'exec' }} opts
 * @returns {(bot: string, tool: string, args: object|null) => Promise<object>}
 */
function makeDispatcher({ botsDir, shellMode = 'echo' } = {}) {
  if (!botsDir) throw new Error('makeDispatcher requires { botsDir }');
  const root = path.resolve(botsDir);
  const botRoot = (bot) => path.join(root, String(bot));

  /**
   * Resolve `target` (a relative path under the bot root) safely, following
   * symlinks to defeat escape via a link planted inside the jail.
   * Returns the canonical absolute resolved path or throws Error('escapes_jail').
   */
  function jailResolve(target, rootDir) {
    if (typeof target !== 'string' || target.length === 0) {
      throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
    }
    // Reject absolute paths outright — they ignore the bot root.
    if (path.isAbsolute(target)) {
      throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
    }
    // Belt-and-suspenders: reject any '..' segment explicitly so the failure
    // mode is obvious rather than silently clamped by path.resolve.
    const parts = target.split(path.sep);
    if (parts.some((p) => p === '..')) {
      throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
    }

    const resolved = path.resolve(rootDir, target);
    const realRoot = tryRealpath(rootDir); // rootDir always exists (ensureDir)

    // 1) If the destination itself exists on disk (file or symlink), canonicalize
    //    it and verify the real location stays under the real root. This is what
    //    defeats a symlink planted inside the jail pointing at /etc/passwd:
    //    realpath follows the link and lands outside.
    const realTarget = tryRealpath(resolved);
    if (realTarget !== undefined) {
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
      }
      return realTarget;
    }

    // 2) Destination does not exist (e.g. writing a brand-new file). Realpath the
    //    deepest existing ancestor, then re-append the not-yet-existing tail and
    //    verify the reconstructed path stays under the real root.
    let p = path.dirname(resolved);
    let realAncestor = undefined;
    while (p !== rootDir && p !== path.parse(p).dir) {
      realAncestor = tryRealpath(p);
      if (realAncestor !== undefined) break;
      p = path.dirname(p);
    }
    if (realAncestor === undefined) realAncestor = realRoot;
    const tail = path.relative(rootDir, resolved); // e.g. "deep/nested/file.txt"
    const canonical = path.join(realAncestor, tail);
    if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
      throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
    }
    return canonical;
  }

  function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return tryRealpath(dir) || path.resolve(dir);
  }

  async function dispatch(bot, tool, args) {
    if (typeof bot !== 'string' || bot.length === 0) {
      throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
    }
    const rootDir = ensureDir(botRoot(bot));

    if (typeof tool !== 'string' || tool.length === 0) {
      return { ok: true, done: true };
    }

    if (tool.startsWith('fs.write:')) {
      const rel = tool.slice('fs.write:'.length);
      const dest = jailResolve(rel, rootDir);
      const content = args && args.content != null ? String(args.content) : '';
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf8');
      return { wrote: rel, bytes: Buffer.byteLength(content, 'utf8') };
    }

    if (tool.startsWith('fs.read:')) {
      const rel = tool.slice('fs.read:'.length);
      const dest = jailResolve(rel, rootDir);
      if (!fs.existsSync(dest)) return { path: rel, content: null };
      const stat = fs.statSync(dest);
      if (stat.isDirectory()) return { path: rel, content: null, isDir: true };
      const content = fs.readFileSync(dest, 'utf8');
      return { path: rel, content };
    }

    if (tool === 'shell.run') {
      const cmd = args && args.cmd;
      if (shellMode === 'exec') {
        if (!cmd) return { ran: null, exitCode: 0, echoed: false, error: 'no_cmd' };
        try {
          const stdout = execFileSync('sh', ['-c', cmd], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10000,
            encoding: 'utf8',
            cwd: rootDir,
          });
          return { stdout, exitCode: 0, echoed: false };
        } catch (e) {
          return {
            stdout: e.stdout ? String(e.stdout) : '',
            stderr: e.stderr ? String(e.stderr) : '',
            exitCode: e.status != null ? e.status : 1,
            echoed: false,
          };
        }
      }
      // default: echo mode (safe demo)
      return { ran: cmd, exitCode: 0, echoed: true };
    }

    // Unknown tools: no-op success.
    return { ok: true, done: true };
  }

  return dispatch;
}

module.exports = { makeDispatcher };
