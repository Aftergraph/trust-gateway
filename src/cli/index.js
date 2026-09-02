'use strict';
// W7 — tg entry point: argument parsing, env resolution (TG_URL/TG_TOKEN),
// subcommand dispatch, and TUI fallback. main() resolves to an exit code;
// bin/tg.js maps it to process.exitCode. Zero dependencies.

const commands = require('./commands');
const { runTui } = require('./tui');
const { connect } = require('./client');
const { makePalette } = require('./format');

const USAGE = `tg — Trust Gateway CLI (v2)

usage: tg <command> [args] [flags]        run without a command for the TUI

commands:
  status                 gateway health · chain · pending · activity
  verify                 verify the tamper-evident audit chain
  audit [since]          audit trail entries (default: newest 25)
  pending                list pending approval requests
  approve <id>           approve a pending request   (operator token)
  deny <id>              deny a pending request      (operator token)
  chat <message...>      ask the governed chat planner
  search <query...>      full-text search the audit chain

flags:
  --json                 machine-readable output (single JSON document)
  --limit <n>            audit/search result cap        -n
  --since <seq>          audit: entries after seq (alias: -s)
  --session <name>       chat session (default: cli; TUI uses its own)
  --bot <name>           chat acting bot                (default: first worker)
  --url <base>           gateway URL  (else $TG_URL)
  --token <bearer>       gateway token (else $TG_TOKEN)
  --color / --no-color   force ANSI on/off (auto: on for TTY, respects NO_COLOR)
  --all                  audit: do not truncate to newest
  -h, --help             this screen

env: TG_URL, TG_TOKEN        exit codes: 0 ok · 1 failure
`;

const FLAGS_WITH_VALUE = new Set(['--limit', '-n', '--since', '--url', '--token', '--session', '--bot']);
const FLAG_ALIASES = { '-n': '--limit', '-s': '--since', '-h': '--help', '-j': '--json' };

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (FLAG_ALIASES[a]) a = FLAG_ALIASES[a];
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && a !== '-')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(0, eq)] = a.slice(eq + 1); continue; }
      if (a === '--json') { flags.json = true; continue; }
      if (a === '--color') { flags.color = true; continue; }
      if (a === '--no-color') { flags.color = false; continue; }
      if (a === '--all') { flags.all = true; continue; }
      if (a === '--help') { flags.help = true; continue; }
      if (FLAGS_WITH_VALUE.has(a)) {
        const v = argv[++i];
        if (v === undefined) throw new Error(`missing value for ${a}`);
        flags[a.replace(/^--/, '')] = v;
        continue;
      }
      throw new Error(`unknown flag ${a}`);
    }
    if (!command) command = a;
    else positionals.push(a);
  }
  return { command, positionals, flags };
}

/**
 * @param {string[]} argv  args after `node bin/tg.js`
 * @param {object} [opts]  { env, stdout, stderr, stdin } for testability
 */
async function main(argv = [], opts = {}) {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const out = (s) => stdout.write(s);
  const err = (s) => stderr.write(s);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`tg: ${e.message}\n`);
    return 1;
  }
  const { command, flags, positionals } = parsed;

  if (flags.help || command === 'help') { out(USAGE); return 0; }

  const color = flags.color ?? (!('NO_COLOR' in env) && (env.FORCE_COLOR || stdout.isTTY ? true : false));
  const palette = makePalette(Boolean(color) && flags.color !== false);

  const conn = connect({ url: flags.url, token: flags.token }, env);
  if (conn.error) { err(`tg: ${palette.bad ? palette.bad('error') : 'error'}: ${conn.error}\n`); return 1; }
  const ctx = { client: conn.client, palette, out, err, json: Boolean(flags.json), flags, positionals };

  // No subcommand → interactive TUI.
  if (!command) {
    return runTui({ client: conn.client, io: { stdin: opts.stdin ?? process.stdin, stdout }, palette });
  }

  const handler = commands[command];
  if (!handler) {
    err(`tg: unknown command “${command}”\n\n${USAGE}`);
    return 1;
  }
  try {
    return await handler(ctx);
  } catch (e) {
    // Only transport-level failures reach here (the SDK resolves 4xx bodies).
    if (ctx.json) out(JSON.stringify({ error: e.message }, null, 2) + '\n');
    else err(`tg: ${palette.bad ? palette.bad(e.message) : e.message}\n`);
    return 1;
  }
}

module.exports = { main, parseArgs, USAGE };
