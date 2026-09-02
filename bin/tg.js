#!/usr/bin/env node
'use strict';
// tg — Trust Gateway CLI + TUI (W7).
//
// usage:  TG_URL=http://host:8800 TG_TOKEN=*** bin/tg.js <command>
//         commands: status · verify · audit · pending · approve · deny ·
//                   chat · search   (add --json for machine output)
//         no command → interactive TUI (/help inside)
//
// Everything talks to the gateway through the GatewayClient SDK
// (src/gateway/client.js, extended by src/cli/client.js). Exit codes: 0/1.

const { main } = require('../src/cli');

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write(`tg: fatal: ${(e && e.message) || e}\n`);
    process.exitCode = 1;
  });
