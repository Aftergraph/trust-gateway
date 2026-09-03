# UX Spec — Trust Gateway

Complete UI/UX specification for the governed agentic console, delivered
alongside the real platform. Reading order:

| File | Sections | Scope |
|---|---|---|
| [00-KERNEL.md](00-KERNEL.md) | — | Binding vocabulary |
| [01-FOUNDATION.md](01-FOUNDATION.md) | §1–§4 | Product, IA, domain model (state machines), surface architecture |
| [02-INTERACTION.md](02-INTERACTION.md) | §5–§8 | Dynamic UI composition, chat/agent/work UX |
| [03-TRUST.md](03-TRUST.md) | §9–§12 | Control/approvals, memory/knowledge, artifacts, gen-UI |
| [04-EXPERIENCE.md](04-EXPERIENCE.md) | §13–§17 | Design system, a11y, responsive, failure, motion |
| [05-SYSTEM.md](05-SYSTEM.md) | §18–§20 | Search/command, extensions, acceptance + rollout |

**Design principle:** Objects persist. Surfaces adapt. Capabilities extend.
Agents act. Humans retain control.

## Rollout phases (§20)
- **Phase 0** — token/theme swap (1 PR, safe): CSS vars + domain-rail.
- **Phase 1** — queue-first History panel (approval list surfaced).
- **Phase 2** — deep-link URIs `/d/<domain>/o/<type>/<id>`.
- **Phase 3** — composition engine behind flag.
- **Phase 4** — extension manifests + TG.session capability-scoped API.

Each phase carries a kill-switch and a tab-id redirect map (old tab ids
rewrite to the new domain rail) — no broken-URL windows.
