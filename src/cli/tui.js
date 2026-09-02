'use strict';
// W7 — interactive TUI. A readline loop over the same command handlers the
// CLI uses, so behavior in tests equals behavior at a terminal. Works with a
// piped stdin too (non-TTY): commands are read line by line, executed in
// order (serialized through a promise chain), and the loop exits 0 on /quit
// or EOF. Unknown lines without a slash are treated as chat messages.

const readline = require('node:readline');
const commands = require('./commands');

const TUI_HELP = [
  'commands:',
  '  /status                gateway health, chain, pending, activity',
  '  /verify                verify the audit chain',
  '  /pending               list pending approval requests',
  '  /approve <id>          approve a pending request (operator token)',
  '  /deny <id>             deny a pending request (operator token)',
  '  /chat <message...>     talk to the chat planner (session persists)',
  '  /audit [since]         recent audit entries',
  '  /search <query...>     full-text search of the audit chain',
  '  /help                  this list',
  '  /quit                  leave (also: Ctrl-D)',
  '  <anything else>        sent as a chat message',
];

const SLASH = new Set(['status', 'verify', 'pending', 'approve', 'deny', 'chat', 'audit', 'search', 'help', 'quit', 'exit']);

/**
 * @param {object} opts
 * @param {CliClient} opts.client
 * @param {object} [opts.io]         { stdin, stdout } (default process)
 * @param {object} opts.palette
 * @returns {Promise<number>} exit code
 */
function runTui({ client, io = process, palette }) {
  const stdout = io.stdout;
  const stdin = io.stdin;
  const terminal = Boolean(stdout.isTTY && stdin.isTTY);
  const session = `tui-${process.pid}`;

  const out = (s) => stdout.write(s);
  const baseCtx = { client, palette, out, json: false, flags: {}, positionals: [] };

  return new Promise((resolve) => {
    out(`${palette.cyan(palette.bold('● trust-gateway TUI'))} ${palette.dim('— ' + client.baseUrl + ' · /help for commands · /quit to exit')}\n`);

    const rl = readline.createInterface({ input: stdin, output: stdout, terminal });
    if (terminal) rl.setPrompt('tg> ');

    let queue = Promise.resolve();
    let closed = false;
    const finish = () => { if (!closed) { closed = true; try { rl.close(); } catch { /* noop */ } resolve(0); } };

    async function exec(line) {
      const text = line.trim();
      if (!text) return;
      let cmd, rest;
      if (text.startsWith('/')) {
        const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
        cmd = (m[1] || '').toLowerCase();
        rest = (m[2] || '').trim();
      } else {
        cmd = 'chat'; // bare text = chat message
        rest = text;
      }
      const ctx = { ...baseCtx, flags: {}, positionals: rest ? rest.split(/\s+/) : [] };
      if (cmd === 'help') { out(TUI_HELP.map((l) => palette.dim(l)).join('\n') + '\n'); return; }
      if (cmd === 'quit' || cmd === 'exit') { out(palette.dim('bye.\n')); finish(); return; }
      if (cmd === 'chat') {
        if (!rest) { out(palette.yellow('usage: /chat <message>  (or just type the message)\n')); return; }
        ctx.session = session;
        ctx.flags = { session };
      }
      const handler = commands[cmd];
      if (!SLASH.has(cmd) || typeof handler !== 'function') {
        out(palette.red(`unknown command /${cmd} — /help lists commands\n`));
        return;
      }
      try {
        const code = await handler(ctx);
        if (code !== 0 && cmd !== 'quit') {
          // errors were already printed by the handler; keep the loop alive.
        }
      } catch (e) {
        out(palette.red(`✗ ${e.message}\n`));
      }
      if (terminal) rl.prompt();
    }

    rl.on('line', (line) => { queue = queue.then(() => exec(line)); });
    rl.on('close', finish);
    if (terminal) rl.prompt();
  });
}

module.exports = { runTui, TUI_HELP };
