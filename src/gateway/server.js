
class Gateway extends EventEmitter {
  constructor({
    bots = {},            // name -> { token, capabilities, role }
    dispatch = null,      // async (bot, tool, args) -> result object
    chain = null,
    approvals = null,
    now = () => Date.now(),
    auditFile = null,     // path -> durable append-only JSONL audit
    approvalsFile = null, // path -> durable approvals (pending survive restart)
    budgets = null,       // v2 Slice 2: BudgetStore instance, or null (feature off)
    mountFiles = true,    // v2: load src/gateway/mounts/*.js plugin routes
    staticDir = null,     // v2: serve SPA from this dir at /
    marketingDir = null,  // v2: serve public site from this dir at /home
    botsDir = null,       // wave C: jails root, available to mount-declared executors
    delegationChainFile = null, // optional durable A2A delegation graph path
    delegationChainTenantId = null, // derive durable graph path from tenant scope
    fnMounts = null,      // array of function-style mount modules to wire (testing)
    mounts = null,        // array of object-style mount modules to register (testing)
    telemetryFile,        // G12: telemetry ring file (default data/telemetry.json; null = memory-only)
    governedEgressBroker = null, // injected governed adapter egress boundary
    adapterCredentialLifecycle = null, // injected tenant-scoped Vault credential lifecycle
    adapterContextResolver = null, // injected trusted mission/authority context resolver
    adapterRuntime = null, // composed adapter runtime; explicit dependencies remain supported
  } = {}) {
    super();
    this.bots = bots;
    this.dispatch = dispatch;
    this.auditFd = null;
    this.marketingDir = marketingDir;
    if (auditFile) {
      const { chain: loaded } = disk.loadChain(auditFile);
      this.chain = chain ?? loaded;
      this.auditFd = disk.openAppendFd(auditFile);
    } else {
      this.chain = chain ?? new HashChain();
    }
    // FS-A5: env-gated SQLite approvals (TG_APPROVALS_DB=1); env unset → the
    // legacy JSON-backed ApprovalStore, byte-identical (WeakMap-cached per gw).
    this.approvals = approvals ?? getApprovals(this, { now, file: approvalsFile, gw: this });
    this.memory = getMemoryStore(this);
    // G12 (§20.4): telemetry ring — observability, NOT the audit chain.
    this.telemetry = new TelemetryRing({ file: telemetryFile !== undefined ? telemetryFile : DEFAULT_TELEMETRY_FILE, now });
    // Adapter routes remain inert unless governed dependencies are explicitly
    // supplied by the embedding control plane. A composed runtime is the
    // preferred atomic seam; individual fields remain for compatibility and
    // tests that inject one boundary at a time.
    const composedAdapterRuntime = adapterRuntime && typeof adapterRuntime === 'object' ? adapterRuntime : {};
    this.governedEgressBroker = governedEgressBroker ?? composedAdapterRuntime.governedEgressBroker ?? null;
    this.adapterCredentialLifecycle = adapterCredentialLifecycle ?? composedAdapterRuntime.adapterCredentialLifecycle ?? null;
    this.adapterContextResolver = adapterContextResolver ?? composedAdapterRuntime.adapterContextResolver ?? null;
    this.budgets = budgets ?? null; // v2 Slice 2: opt-in; null => feature off => zero behavior change
    this.now = now;
    this.mounts = mountFiles ? loadMounts() : (Array.isArray(mounts) ? mounts.slice() : []);
    // Function-style mounts (120+): wire via gw.router facade. Each mount is
    // called once with (gw) and registers routes on this._fnRoutes.
    this._fnRoutes = [];
    this._fnMountQueue = [];
    if (mountFiles) {
      const skippedFn = [];