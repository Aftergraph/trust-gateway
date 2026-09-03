// FS-W5 — deep healthz mount. Public, no auth (useful for load balancers).

const { check } = require('../healthz-deep');

module.exports = function mountHealthzDeep(gw) {
  gw.router.get('/v2/healthz/deep', async (req, res) => {
    const r = check();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(r));
  });
};
