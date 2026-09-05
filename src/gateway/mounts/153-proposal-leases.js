'use strict';
// E4 mount: GET /v2/proposals/:id/leases — AIE leases for en proposal's mission.
// Henter MissionProposal's stamped mission_id, filtrerer /v2/authority leases
// på mission_id, og returnerer { ok, proposalId, missionId, leases }.
// Fail-closed overalt:
//   404 ukendt proposal
//   403 worker (authority er operator-only — /v2/authority kræver canApprove)
//   AIE utilgængelig → 200 { leases: [], unavailable: true } (ingen syntetiske
//   data — operatøren ser en tom liste, aldrig opdigtede leases)
// AIE-leasing læses via AIE_HTTP_URL hvis sat (samme kontrakt som 132), ellers
// subprocess-bridge (legacy). 132-authority-proxy eksporterer authorityReadHttp.

const { send } = require('../server');
const { canApprove } = require('../rbac');
const { MissionProposalStore } = require('../missions');
const authorityProxy = require('./132-authority-proxy.js');

const RE = /^\/v2\/proposals\/([^/]+)\/leases\/?$/;
const kinds = authorityProxy.KINDS || [];

module.exports = {
  name: 'v2-proposal-leases',
  method: 'GET',
  path: RE,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!canApprove(ctx.bot)) {
      return send(res, 403, { ok: false, error: 'forbidden', reason: 'authority leases are operator-only' });
    }

    const m = RE.exec(ctx.url.pathname);
    if (!m) return send(res, 404, { ok: false, error: 'not_found' });
    const proposalId = decodeURIComponent(m[1]);

    if (!gw._proposalStore) gw._proposalStore = new MissionProposalStore();
    const store = gw._proposalStore;
    const proposal = typeof store.get === 'function' ? store.get(proposalId) : null;
    if (!proposal) {
      return send(res, 404, { ok: false, error: 'not_found', proposalId });
    }

    const missionId = (proposal.correlation && proposal.correlation.mission_id) || proposal.mission_id || null;

    let leases = [];
    let unavailable = false;

    if (missionId) {
      // Prøv HTTP-transport (AIE_HTTP_URL), fald tilbage til subprocess-bridge.
      // Genbrug 132's interne authorityRead via dens async read-any path:
      // enklast: kald dens fnMounts-registerede router via gw.router? Nej —
      // 132 eksporterer IKKE læseren. Læs direkte via AIE gateway hvis sat;
      // ellers subprocess (samme env-kontrakt som 132).
      const httpUrl = process.env.AIE_HTTP_URL || '';
      let got = null;
      if (httpUrl && kinds.includes('leases')) {
        try {
          const headers = {};
          if (process.env.AIE_HTTP_TOKEN) headers.authorization = `Bearer ${process.env.AIE_HTTP_TOKEN}`;
          const resp = await fetch(`${httpUrl.replace(/\/$/, '')}/leases`, {
            headers, signal: AbortSignal.timeout(10_000),
          });
          if (resp.ok) {
            const data = await resp.json();
            got = Array.isArray(data) ? data : (data.leases || []);
          } else if (resp.status === 401 || resp.status === 403) {
            unavailable = true;
          } else {
            unavailable = true;
          }
        } catch { unavailable = true; }
      } else {
        // subprocess fallback — via 132's bridge-kontrakt
        try {
          const { spawnSync } = require('child_process');
          const path = require('node:path');
          const runtimePath = process.env.AIE_RUNTIME_PATH || path.join(__dirname, '..', '..', '..', 'aie');
          const bridge = path.join(runtimePath, 'scripts', 'aie_authority_bridge.py');
          const stateFile = process.env.AIE_STATE_FILE || path.join(process.cwd(), 'data', 'aie-state.db');
          const py = process.env.AIE_PYTHON || 'python';
          const result = spawnSync(py, [bridge, '--state', stateFile, '--kind', 'leases'], {
            timeout: 10000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
          });
          if (result.status === 0) {
            const parsed = JSON.parse((result.stdout || '').trim().split('\n').pop());
            got = Array.isArray(parsed) ? parsed : (parsed.leases || parsed.items || []);
          } else {
            unavailable = true;
          }
        } catch { unavailable = true; }
      }

      if (got === null) {
        unavailable = true;
      } else {
        leases = got.filter((l) => l && (l.mission_id === missionId || l.missionId === missionId));
      }
    }

    gw._audit({ type: 'proposal_leases', proposalId, missionId, count: leases.length, unavailable });
    send(res, 200, {
      ok: true,
      proposalId,
      missionId,
      leases,
      ...(unavailable ? { unavailable: true } : {}),
    });
  },
};