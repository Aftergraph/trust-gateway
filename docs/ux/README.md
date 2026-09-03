# UX Spec — Trust Gateway

Complete, future-proof UI/UX specification for the governed agentic console.
Structure per product owner: 20 sections across 5 bound documents + kernel.

**Design principle (normative):** Objects persist. Surfaces adapt.
Capabilities extend. Agents act. Humans retain control.

## Reading order

| File | Sections | Scope |
|---|---|---|
| [00-KERNEL.md](00-KERNEL.md) | — | Binding vocabulary: domains, objects, roles, surfaces, MUST/SHOULD/MAY |
| [01-FOUNDATION.md](01-FOUNDATION.md) | §1–§4 | Product definition, information architecture, core domain model (state machines), surface architecture |
| [02-INTERACTION.md](02-INTERACTION.md) | §5–§8 | Dynamic UI composition, chat UX, agent UX, work/mission UX |
| [03-TRUST.md](03-TRUST.md) | §9–§12 | Control/approvals/trust, context/memory/knowledge, artifacts, generative UI |
| [04-EXPERIENCE.md](04-EXPERIENCE.md) | §13–§17 | Design system (`--tg-*` tokens), accessibility, responsive/cross-device, failure & recovery UX, motion/live states |
| [05-SYSTEM.md](05-SYSTEM.md) | §18–§20 | Search & command system (⌘K), extensions/capabilities, acceptance criteria + 5-phase production rollout |

## Consolidated BACKEND GAP themes (45 flags across the spec)

Recurring demands the current platform does not yet satisfy — candidates for
the next build waves, deduplicated:

1. **First-class Run/Step/Goal lifecycle objects** (today implicit in
   continuity ticks; needs `data/runs.json` + audit types `step_interrupted`,
   `action_interrupted`) — §1/§3/§8.
2. **Dynamic UI composition engine** (scoring function over
   intent/context/risk/permissions/device/attention; client-side stub until
   a mount computes stacks) — §5, gate for rollout phase 3.
3. **12-role model over Identity+Role+Scope+Capability+Policy**
   (RBAC + capability + temp/delegated grants; today: worker/operator only)
   — §3/§9.
4. **Impact analysis + rollback plan fields on Approval** (card renders
   honest "pending backend support" skeleton until then; MUST NOT fabricate)
   — §9.
5. **Batch approval endpoint + keyboard-complete queue** — §9/§14.
6. **Trust score query endpoint** per message (scanner primitives exist, no
   read surface) — §6/§9.
7. **Dry-run simulation sandbox** for the builder (project capability usage
   and risk without executing) — §7.
8. **Memory as inspectable objects** (view/edit/delete per entry, decay,
   provenance; knowledge-chunk provenance; `memoryPolicy` on agent records)
   — §10.
9. **Cost/credit preview before runs** (token estimate in composers —
   born from the real 402 credits incident) — §10/§16.
10. **Artifact lifecycle + signed-expiry sharing links** — §11.
11. **Extension manifests + capability-scoped TG.session API** (panels must
    not reach raw fetch with operator tokens) — §19.
12. **FTS5 unified search index exposure + ⌘K palette** — §18.
13. **CI/telemetry**: no automated a11y (axe/SR/keyboard) or conformance-tier
    smoke matrix yet — §14/§20.

## Ground rules for implementers

- The platform is real: 630 tests, 72 audit types, 13-tab console. Proposals
  bind through mounts/executors/TG_PANELS per docs/v2/PLATFORM-ABI.md.
- Rollout is phased 0→4 with kill-switches and a tab-id redirect map
  (§20) — no big-bang rewrite, no broken-URL windows.
