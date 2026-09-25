'use strict';

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function defaultTerminate() {
  process.kill(process.pid, 'SIGKILL');
}

function createPostTransportCrashTransport(baseTransport, {
  enabled = false,
  terminate = defaultTerminate,
} = {}) {
  if (typeof baseTransport !== 'function') throw fail('study015_base_transport_required');
  if (typeof terminate !== 'function') throw fail('study015_terminator_required');

  return async function study015PostTransportCrash(request, context) {
    const result = await baseTransport(request, context);
    const status = Number(result?.status || 0);

    // The L7 fault boundary is deliberately AFTER the external transport has
    // returned success, but BEFORE GovernedEgressBroker can append
    // egress_dispatched and before GovernedGitEgress can append
    // git_egress_completed. A real SIGKILL never returns.
    if (enabled && status >= 200 && status < 300) {
      terminate({ request, context, result });
      throw fail('study015_post_transport_terminator_returned');
    }

    return result;
  };
}

module.exports = {
  createPostTransportCrashTransport,
};
