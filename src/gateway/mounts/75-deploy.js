'use strict';
// C5 mount — deploy artifacts + status reporting over HTTP.
//
// GET /v2/deploy/status            (bearer) → statusReport(gw) snapshot.
// GET /v2/deploy/artifact?kind=service|launcher (bearer) → rendered text
//   artifact. Every download is audited as `deploy_artifact` (payload is
//   JSON-round-trip safe; only the kind + a byte count, never file content).
//
// Auth note: this module NEVER reads tokens. The mount runner validated the
// bearer token against gw.bots before handle() runs.

const { send } = require('../server');
const deploy = require('../deploy');

module.exports = {
  name: 'v2-deploy',
  method: 'GET',
  path: /^\/v2\/deploy\/(status|artifact)$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const kind = ctx.url.searchParams.get('kind') || null;

    if (ctx.url.pathname === '/v2/deploy/status') {
      return send(res, 200, deploy.statusReport(gw));
    }

    if (kind !== 'service' && kind !== 'launcher') {
      return send(res, 400, { error: 'bad_kind', hint: 'kind=service|launcher' });
    }

    let artifact;
    if (kind === 'service') {
      artifact = deploy.renderService({
        port: Number(ctx.url.searchParams.get('port')) || undefined,
        envFile: ctx.url.searchParams.get('envFile') || undefined,
      });
    } else {
      const r = deploy.renderPwaShortcut({ url: ctx.url.searchParams.get('url') || undefined });
      artifact = r.desktop;
    }

    gw._audit({
      type: 'deploy_artifact',
      kind,
      bytes: Buffer.byteLength(artifact, 'utf8'),
      by: ctx.bot ? ctx.bot.name : null,
    });

    send(res, 200, { kind, artifact });
  },
};