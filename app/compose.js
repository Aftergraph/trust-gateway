'use strict';
// Trust Gateway v2 — Phase 3 (§5 + §19.3): the Dynamic UI Composition engine.
//
// Pure, deterministic decision function: composition context vector in →
// surface stack out. NOT a layout library — it decides WHICH surfaces
// appear, in WHAT order, for WHOM, given WHAT. Lives behind a flag
// (?compose=true or localStorage['tg-compose']); the Phase-2 tab router is
// the instant fallback when the flag is off.
//
// §5.1 inputs (exactly these): intent, context, workState, risk,
// permissions, capabilities, device, attention.
// §5.2 rule order (MUST first):
//   1. risk=destructive → Modal/Drawer gate at stack position 0, background
//      surfaces dimmed. Destructive actions MUST NOT render inline.
//   2. workState=awaiting-approval → Queue pinned at 0 for the approver,
//      regardless of intent.
//   3. learned preferences: NOT implemented (MAY; reserved — engine stays
//      deterministic, per §4.6 "same tuple → same plan").
//   4. device density: mobile collapses Detail→Summary (class preserved —
//      MUST never drop a surface class).
// §19.3 capability filter: panels whose domains ∉ [domain] are omitted
// (reason 'intent'); within the enabled set, panels whose
// requiredCapabilities are not granted have their ACTION surfaces hidden —
// the panel itself still renders with a 'capability missing' note.
// §4.6: every unmatched surface stays in the plan as omitted with
// omittedBecause ∈ {risk, capability, intent, device} — any other value is
// an engine bug (asserted by the test harness).
//
// XSS policy: this module builds data only; rendering stays textContent-only
// in the router.

(function () {
  // ── kernel surface vocabulary (00-KERNEL.md, refine don't reinvent) ────
  const SURFACES = Object.freeze([
    'Feed', 'Board', 'Graph', 'Detail', 'Composer', 'Diff',
    'EvidencePanel', 'Queue', 'Timeline', 'Terminal', 'Modal/Drawer',
  ]);
  const INTENTS = Object.freeze(['explore', 'compose', 'execute', 'approve', 'review', 'monitor', 'admin']);
  const RISKS = Object.freeze(['read', 'write', 'destructive', 'secret']);
  const WORK_STATES = Object.freeze(['idle', 'running', 'blocked', 'awaiting-approval', 'error', 'done']);
  const DEVICES = Object.freeze(['desktop', 'mobile', 'terminal']);
  const KERNEL_DOMAINS = Object.freeze(['NOW', 'CHAT', 'WORK', 'AGENTS', 'BRAIN', 'OUTPUT', 'CONTROL', 'CONNECT', 'SYSTEM']);
  const OMIT_REASONS = Object.freeze(['risk', 'capability', 'intent', 'device']);

  // ── §19.3 canonical manifests for the built-in panels ─────────────────
  // (extension panels bring their own manifest; the engine validates any
  // manifest the same way — this table is just the shipped set.)
  const MANIFESTS = Object.freeze([
    { id: 'console', title: 'Console (NOW)', version: '2.0.0', domains: ['NOW'],
      requiredCapabilities: [], surfaces: ['Feed', 'Queue', 'Detail', 'Composer', 'Modal/Drawer'],
      surfacesUsed: ['Feed', 'Queue', 'Detail', 'Composer'],
      actionSurfaces: { Queue: ['approval.decide'] },
      entry: 'app.js', lazy: false, hidden: false, required: true, order: 0 },
    { id: 'rooms', title: 'Rooms', version: '1.0.0', domains: ['CHAT'],
      requiredCapabilities: [], surfaces: ['Feed', 'Composer'], surfacesUsed: ['Feed', 'Composer'],
      entry: 'panels/rooms.js', lazy: true, hidden: false, required: false, order: 0 },
    { id: 'goals', title: 'Goals & Loops', version: '1.0.0', domains: ['WORK'],
      requiredCapabilities: [], surfaces: ['Board', 'Detail', 'Timeline'], surfacesUsed: ['Board', 'Detail', 'Timeline'],
      actionSurfaces: { Board: ['goal.create'] },
      entry: 'panels/goals.js', lazy: true, hidden: false, required: false, order: 0 },
    { id: 'builder', title: 'Workforce builder', version: '1.0.0', domains: ['WORK', 'AGENTS'],
      requiredCapabilities: [], surfaces: ['Composer', 'Detail', 'Diff', 'Board'], surfacesUsed: ['Composer', 'Detail', 'Diff', 'Board'],
      actionSurfaces: { Composer: ['agent.manage'] },
      entry: 'panels/builder.js', lazy: true, hidden: false, required: false, order: 1 },
    { id: 'agents', title: 'Agents', version: '1.0.0', domains: ['AGENTS'],
      requiredCapabilities: [], surfaces: ['Board', 'Detail'], surfacesUsed: ['Board', 'Detail'],
      entry: 'panels/agents-system.js', lazy: true, hidden: false, required: false, order: 0 },
    { id: 'providers', title: 'Models & Providers', version: '1.0.0', domains: ['BRAIN'],
      requiredCapabilities: [], surfaces: ['Board', 'Detail'], surfacesUsed: ['Board', 'Detail'],
      actionSurfaces: { Detail: ['provider.select'] },
      entry: 'panels/providers.js', lazy: true, hidden: false, required: false, order: 0 },
    { id: 'providers-live', title: 'Providers Live', version: '1.0.0', domains: ['BRAIN'],
      requiredCapabilities: [], surfaces: ['Feed', 'Detail'], surfacesUsed: ['Feed', 'Detail'],
      entry: 'panels/providers-live.js', lazy: true, hidden: false, required: false, order: 1 },
    { id: 'artifacts', title: 'Artifacts', version: '1.0.0', domains: ['OUTPUT'],
      requiredCapabilities: [], surfaces: ['Board', 'Detail', 'Diff'], surfacesUsed: ['Board', 'Detail', 'Diff'],
      entry: 'panels/artifacts.js', lazy: true, hidden: false, required: false, order: 0 },
    { id: 'history', title: 'History', version: '1.0.0', domains: ['OUTPUT'],
      requiredCapabilities: [], surfaces: ['Feed', 'Detail', 'EvidencePanel'], surfacesUsed: ['Feed', 'Detail', 'EvidencePanel'],
      entry: 'panels/history.js', lazy: true, hidden: false, required: false, order: 1 },
    { id: 'playground', title: 'Playground', version: '1.0.0', domains: ['OUTPUT'],
      requiredCapabilities: [], surfaces: ['Composer', 'Terminal'], surfacesUsed: ['Composer', 'Terminal'],
      actionSurfaces: { Terminal: ['harness.run'] },
      entry: 'panels/playground.js', lazy: true, hidden: false, required: false, order: 2 },
    { id: 'computer', title: 'Computer', version: '1.0.0', domains: ['CONTROL'],
      requiredCapabilities: [], surfaces: ['Feed', 'Detail', 'Modal/Drawer'], surfacesUsed: ['Feed', 'Detail'],
      actionSurfaces: { Detail: ['control.take'] },
      entry: 'panels/computer.js', lazy: true, hidden: false, required: false, order: 0 },
    { id: 'hub', title: 'Hub', version: '1.0.0', domains: ['CONNECT'],
      requiredCapabilities: [], surfaces: ['Board', 'Detail'], surfacesUsed: ['Board', 'Detail'],
      actionSurfaces: { Board: ['plugin.install'] },
      entry: 'panels/hub.js', lazy: true, hidden: false, required: false, order: 0 },
    { id: 'integrations', title: 'Integrations', version: '1.0.0', domains: ['CONNECT'],
      requiredCapabilities: [], surfaces: ['Board', 'Composer'], surfacesUsed: ['Board', 'Composer'],
      actionSurfaces: { Composer: ['adapter.manage'] },
      entry: 'panels/integrations.js', lazy: true, hidden: false, required: false, order: 1 },
    { id: 'voice', title: 'Voice', version: '1.0.0', domains: ['CONNECT'],
      requiredCapabilities: [], surfaces: ['Composer', 'Detail'], surfacesUsed: ['Composer', 'Detail'],
      entry: 'panels/voice.js', lazy: true, hidden: false, required: false, order: 2 },
    { id: 'system', title: 'System', version: '1.0.0', domains: ['SYSTEM'],
      requiredCapabilities: [], surfaces: ['Board', 'Terminal'], surfacesUsed: ['Board', 'Terminal'],
      entry: 'panels/agents-system.js', lazy: true, hidden: false, required: false, order: 0 },
  ]);

  // ── §19.3/G7 validation harness (the spec's named gap, closed here) ────
  const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
  const SEMVER_RE = /^\d+\.\d+\.\d+$/;
  function validateManifest(m) {
    const errors = [];
    if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest must be an object'] };
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errors.push('id: lowercase slug required');
    if (typeof m.title !== 'string' || m.title.length < 1 || m.title.length > 64) errors.push('title: 1–64 chars required');
    if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) errors.push('version: semver x.y.z required');
    if (!Array.isArray(m.domains) || !m.domains.length) errors.push('domains: non-empty array required');
    else for (const d of m.domains) if (KERNEL_DOMAINS.indexOf(d) === -1) errors.push('domains: unknown domain ' + d);
    for (const k of ['requiredCapabilities', 'surfaces', 'surfacesUsed']) {
      if (!Array.isArray(m[k])) { errors.push(k + ': array required'); continue; }
      if (k !== 'requiredCapabilities') {
        for (const s of m[k]) if (SURFACES.indexOf(s) === -1) errors.push(k + ': surface not in kernel vocabulary: ' + s);
      }
    }
    if (typeof m.entry !== 'string' || m.entry.includes('..')) errors.push('entry: relative .js path without .. required');
    for (const k of ['lazy', 'hidden', 'required']) if (typeof m[k] !== 'boolean') errors.push(k + ': boolean required');
    if (m.keybindings !== undefined) {
      if (!Array.isArray(m.keybindings)) errors.push('keybindings: array required');
      else {
        for (const kb of m.keybindings) {
          if (!kb || typeof kb.key !== 'string' || typeof kb.action !== 'string' ||
              ['global', 'queue', 'palette'].indexOf(kb.context) === -1) errors.push('keybindings: {key,context∈global|queue|palette,action} required');
        }
        // G5 (§18.7): manifest keybindings go through the same conflict check
        // as the TG_KEYS registry — no double (context, key) binding, ever.
        const kc = (typeof window !== 'undefined' && window.TG_KEYS && typeof window.TG_KEYS.detectConflicts === 'function')
          ? window.TG_KEYS.detectConflicts(m.keybindings)
          : localKbConflicts(m.keybindings);
        for (const c of kc) errors.push('keybindings: duplicate (context,key) binding: ' + c.context + ' "' + c.key + '"');
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // ── the decision function (§5.1 → §5.2) ────────────────────────────────
  function riskRank(r) { const i = RISKS.indexOf(r); return i === -1 ? 0 : i; }

    // G5: local duplicate-(context,key) scan — same semantics as
    // TG_KEYS.detectConflicts, used when keys.js is not in the sandbox.
    function localKbConflicts(kbs) {
      const seen = {};
      const dupes = [];
      (kbs || []).forEach((b, i) => {
        if (!b || typeof b.key !== 'string' || typeof b.context !== 'string') return;
        const id = b.context + '::' + String(b.key).trim().toLowerCase();
        if (seen[id] !== undefined) dupes.push({ context: b.context, key: b.key, index: i, first: seen[id] });
        else seen[id] = i;
      });
      return dupes;
    }

  function capabilitiesGranted(need, have) {
    if (!need || !need.length) return true;
    for (const c of need) {
      if (have.indexOf(c) !== -1 || have.indexOf('*') !== -1) return true; // '*' grants all
    }
    return false;
  }
  function everyCapability(need, have) {
    if (!need || !need.length) return true;
    if (have.indexOf('*') !== -1) return true;
    for (const c of need) if (have.indexOf(c) === -1) return false;
    return true;
  }

  const DOMAIN_INTENT = {
    now: 'monitor', chat: 'compose', work: 'execute', agents: 'admin', brain: 'explore',
    output: 'review', control: 'approve', connect: 'admin', system: 'admin',
  };
  const QUEUE_PROVIDER = 'console'; // the panel that owns the Queue surface

  // ctx: { domain, intent?, context?, workState?, risk?, capabilities?, device?, attention? }
  function composePlan(ctx, catalog) {
    ctx = ctx || {};
    const domain = String(ctx.domain || 'now').toLowerCase();
    const domainUpper = domain.toUpperCase();
    const intent = INTENTS.indexOf(ctx.intent) !== -1 ? ctx.intent : (DOMAIN_INTENT[domain] || 'explore');
    const workState = WORK_STATES.indexOf(ctx.workState) !== -1 ? ctx.workState : 'idle';
    const risk = RISKS.indexOf(ctx.risk) !== -1 ? ctx.risk : 'read';
    const capabilities = Array.isArray(ctx.capabilities) ? ctx.capabilities : [];
    const device = DEVICES.indexOf(ctx.device) !== -1 ? ctx.device : 'desktop';
    const attention = (ctx.attention && typeof ctx.attention === 'object') ? ctx.attention : { queueCount: 0 };
    const queueCount = Math.max(0, Number(attention.queueCount) || 0);
    const list = Array.isArray(catalog) && catalog.length ? catalog : MANIFESTS;

    const omitted = [];
    const unknownIntent = ctx.intent !== undefined && INTENTS.indexOf(ctx.intent) === -1;

    // §5.1 MUST: unknown intent → fallback surface (Feed) only.
    if (unknownIntent) {
      return {
        intent: 'explore', fallback: true, surface: 'Feed', stack: [],
        omitted: [{ panel: null, omittedBecause: 'intent', note: 'unknown-intent→Feed' }],
        dim: [], deterministic: true,
      };
    }

    let enabled = [];
    for (const m of list) {
      const v = validateManifest(m);
      if (!v.ok) { omitted.push({ panel: (m && m.id) || '(invalid)', omittedBecause: 'capability', errors: v.errors }); continue; }
      if (m.hidden) continue; // palette-only by declaration
      if (m.domains.indexOf(domainUpper) === -1) { omitted.push({ panel: m.id, omittedBecause: 'intent' }); continue; }
      enabled.push(m);
    }

    // deterministic base order: declared order, tie-break by id.
    enabled.sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const stack = enabled.map((m) => ({
      panel: m.id,
      required: Boolean(m.required),
      surfaces: m.surfacesUsed.slice(),
      surfacesOmitted: [],
      actionSurfacesHidden: [],
      capabilityMissing: false,
      pinned: false,
      density: null,
    }));

    // §19.3 capability filter: hide ACTION surfaces, never the panel.
    for (let i = 0; i < stack.length; i++) {
      const m = enabled[i];
      const s = stack[i];
      if (m.actionSurfaces) {
        for (const surfaceName in m.actionSurfaces) {
          const need = m.actionSurfaces[surfaceName];
          if (!everyCapability(need, capabilities)) {
            s.actionSurfacesHidden.push(surfaceName);
            s.surfaces = s.surfaces.filter((x) => x !== surfaceName);
            s.surfacesOmitted.push({ surface: surfaceName, omittedBecause: 'capability' });
            omitted.push({ panel: m.id, surface: surfaceName, omittedBecause: 'capability' });
          }
        }
      }
      if (!capabilitiesGranted(m.requiredCapabilities, capabilities)) s.capabilityMissing = true;
    }

    // §5.2 rule 1 (MUST): risk override — destructive → Modal/Drawer gate at
    // position 0, all background surfaces dimmed.
    let dim = [];
    if (risk === 'destructive' || risk === 'secret') {
      stack.unshift({
        panel: '__risk_gate', required: false, surfaces: ['Modal/Drawer'], surfacesOmitted: [],
        actionSurfacesHidden: [], capabilityMissing: false, pinned: true, density: null, gate: true,
      });
      dim = stack.slice(1).map((s) => s.panel);
      // destructive actions must not render inline: strip Composer/Queue
      // action affordances from the background layers.
      for (let i = 1; i < stack.length; i++) {
        const s = stack[i];
        for (const x of ['Composer', 'Queue']) {
          if (s.surfaces.indexOf(x) !== -1) {
            s.surfacesOmitted.push({ surface: x, omittedBecause: 'risk' });
            omitted.push({ panel: s.panel, surface: x, omittedBecause: 'risk' });
          }
        }
        s.surfaces = s.surfaces.filter((x) => x !== 'Composer' && x !== 'Queue');
      }
    }

    // §5.2 rule 2 (MUST): awaiting-approval → Queue pinned at 0.
    if (workState === 'awaiting-approval' || (queueCount > 0 && riskRank(risk) >= 1)) {
      const qi = stack.findIndex((s) => s.surfaces.indexOf('Queue') !== -1 || s.panel === QUEUE_PROVIDER);
      if (qi > 0) {
        const qs = stack.splice(qi, 1)[0];
        if (qs.surfaces.indexOf('Queue') === -1) qs.surfaces.unshift('Queue');
        qs.pinned = true;
        stack.unshift(qs);
      } else if (qi === -1) {
        stack.unshift({
          panel: QUEUE_PROVIDER, required: true, surfaces: ['Queue'], surfacesOmitted: [],
          actionSurfacesHidden: [], capabilityMissing: false, pinned: true, density: null,
        });
      }
    }

    // §5.2 rule 4 (MAY device density; MUST keep surface classes).
    if (device === 'mobile') {
      for (const s of stack) {
        for (let i = 0; i < s.surfaces.length; i++) {
          if (s.surfaces[i] === 'Detail') { s.surfaces[i] = 'Summary'; s.density = 'collapsed'; }
        }
        // Detail class is preserved via Summary mapping (documented in §5.2).
      }
    }

    return {
      intent, domain: domainUpper, workState, risk, device,
      queueCount, dim, stack, omitted, deterministic: true,
    };
  }

  // ── browser flag + globals ─────────────────────────────────────────────
  function composeEnabled() {
    try {
      if (/[?&]compose=true\b/.test(location.search)) return true;
      return localStorage.getItem('tg-compose') === 'true';
    } catch { return false; }
  }

  window.TG_COMPOSE = {
    SURFACES, INTENTS, RISKS, WORK_STATES, DEVICES, KERNEL_DOMAINS, OMIT_REASONS,
    MANIFESTS, validateManifest, composePlan, composeEnabled, DOMAIN_INTENT,
  };
})();
