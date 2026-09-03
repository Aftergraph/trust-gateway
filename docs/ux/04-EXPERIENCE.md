# Trust Gateway v2 — Experience: Design System, Accessibility, Responsive, Failure, Motion

> **RESUMÉ:** Denne spec definerer det visuelle og oplevelsesmæssige system for Trust Gateway — et operatørs-konsolprodukt, hvor alvorlighed, bevis-først og anti-glans er normer. Alle tokens er implementerbare CSS-tilpasninger; alle fejlklasser er rod-i-kode (ikke vision). Specen binder til `docs/ux/00-KERNEL.md` (vocabulary) og `docs/v2/PLATFORM-ABI.md` (platform-isn't).

---

## §13 Design system — visual identity for a governed product

### 13.1 Visual identity

The Trust Gateway console is an **operations surface**, not a chat app with extras (00-KERNEL: "The console is not a chat app with extras; it is an operations surface where chat is one of several entry points"). The visual system enforces this through three anti-goals and a density philosophy:

- **Anti-goal 1 — No consumer-chat gloss.** No rounded petal buttons, no drop shadows on cards, no gradients, no illustrations, no empty states that look like error screens. Every pixel earns its information weight.
- **Anti-goal 2 — No gradient soup.** Color is a *single* semantic axis (risk) plus a *single* ambient axis (surface elevation). No chromatic decoration. The palette is 8 base tokens, not 40.
- **Anti-goal 3 — No decorative motion.** Every animation is state telemetry (§17). If it doesn't communicate liveness or risk, it is removed.

**Density philosophy:** Operators live in **compact** mode (dense scan lines, tight rows, small tap targets where precision exceeds 44px). Comfortable mode exists for manager-review tablets and approver phone flows where glance-and-act must not misclick. The default is compact; comfortable is an opt-in surface modifier.

### 13.2 Token architecture

All tokens are declared as `--tg-*` CSS custom properties on `:root`. The console is **dark-first**; light parity is defined via a `@media (prefers-color-scheme: light)` override block that maps each token to its light-surface equivalent (same semantics, lighter background values, same text contrast ratio ≥ 4.5:3). No token is dark-only.

#### 13.2.1 Surface scale (elevation without color)

| Token | Value | Role |
|---|---|---|
| `--tg-bg-base` | `#0b0e14` | Page body, offline.html |
| `--tg-bg-surface` | `#0d1117` | Header, footer, card surfaces |
| `--tg-bg-elevated` | `#11151f` | Panes, panel views, chat bubbles, `.card` |
| `--tg-bg-hover` | `#161b26` | Row hover, `.row`, `.botrow` |
| `--tg-border` | `#21262d` | Default borders, dividers |
| `--tg-border-strong` | `#30365d` | Card borders, modal overlays |
| `--tg-text` | `#c9d1d9` | Body text |
| `--tg-text-bright` | `#e6edf3` | Headings, brand, card-title |
| `--tg-text-muted` | `#8b949e` | Muted labels, `.muted`, ages, dec labels |

#### 13.2.2 Risk palette (read / write / destructive / secret)

| Token | Value | Class | Background pair |
|---|---|---|---|
| `--tg-risk-read` | `#79c0ff` | `read` | `--tg-risk-read-bg` = `#1c2a3a` |
| `--tg-risk-write` | `#e3b341` | `write` | `--tg-risk-write-bg` = `#332a12` |
| `--tg-risk-destructive` | `#f85149` | `destructive` | `--tg-risk-destructive-bg` = `#3a1c1c` |
| `--tg-risk-secret` | `#d2a8ff` | `secret` | `--tg-risk-secret-bg` = `#2a1c3a` |

**Redundancy strategy (color is NEVER the only channel):** Every risk token is paired with a background fill token AND a semantic class tag (`.tag.decision` / `.tag.exec` / `.tag.approval` / `.tag.deny` / `.tag.chat`) AND a text label (the `type` string is always rendered as text, never inferred from color alone). The `.dec` sub-token carries the decision word as text (`allow`, `needs_approval`, `deny`). Source: `app/style.css` — `.tag.decision`, `.tag.exec`, `.tag.approval`, `.tag.deny`, `.tag.chat`, `.dec.allow`, `.dec.needs_approval`, `.dec.deny`.

#### 13.2.3 State colors (ok / blocked / pending / unknown)

| Token | Value | Semantic | Redundancy |
|---|---|---|---|
| `--tg-state-ok` | `#58d68d` | Allowed, sealed, verified | Dot `.dot.on` with `box-shadow` glow + text "SEALED ✓" in `.pill.sealed` + chain verify `{ok:true}` |
| `--tg-state-blocked` | `#f85149` | Denied, expired, tampered, forbidden | Dot `.dot.off` + text "TAMPERED ✖" in `.pill.tambered` + `.card.done` opacity |
| `--tg-state-pending` | `#e3b341` | Waiting, countdown, unverified | `.countdown` text + `.tag.approval` + `border-color: #e3b341` on card |
| `--tg-state-unknown` | `#8b949e` | Disconnected, not configured, unreachable | `.hash` text + `.muted` + `.panel-placeholder` italic + `.empty` |

**Critical rule:** State is NEVER conveyed by color alone. Every state token appears in at least two channels: (a) color + (b) text/icon. The chain verify status is rendered as both the `.pill.sealed`/`.pill.tambered` color AND the literal text `SEALED ✓` / `TAMPERED ✖` (`app/app.js` `setPill`). The approval countdown renders as text ("expires in 42s", "expired") — never as a color-only bar.

#### 13.2.4 Type scale

| Token | Value | Usage |
|---|---|---|
| `--tg-text-xs` | `10px` | Ages, `.hash` (truncated), tag font, `.dec` |
| `--tg-text-sm` | `11px` | Muted labels, `.pill`, `.kbd-hints`, `.card-reason` |
| `--tg-text-base` | `13px` | Body, rows, botrow, input |
| `--tg-text-md` | `14px` | Chat messages, `.card-title`, `.panel-view h3` |
| `--tg-text-lg` | `15px` | `.brand`, `.card .v` |
| `--tg-text-xl` | `18px` | Offline h1, h1 in dashboard |
| `--tg-text-mono` | `ui-monospace, Menlo, Consolas, monospace` | **ALL** numeric/id surfaces |

**Monospace-for-ids rule:** Every 64-character SHA-256 hash renders in `--tg-text-mono` with a **short-copy form**: first 8 characters visible, full hash on copy (title attribute or copy handler). Source: `app/app.js` `streamRow` renders `'#' + e.seq + ' ' + String(e.hash).slice(0, 8)`; `app/server.js` `dashboardHtml` renders `e.hash.slice(0, 12)…`. The spec requires the **8-char short form** as the default display (consistent with `app.js`), with the full 64-char hash available on copy interaction. Chain-refs (e.g., `prevHash`, `head`) follow the same rule.

#### 13.2.5 Spacing, radius, elevation

| Token | Value | Usage |
|---|---|---|
| `--tg-space-1` | `4px` | Inline gaps within rows |
| `--tg-space-2` | `8px` | `.gap-8` row gaps, `.card` internal |
| `--tg-space-3` | `12px` | `.gap-12` pane gaps, `.pane-body` padding |
| `--tg-space-4` | `16px` | `.gap-16` panel padding, `.panel-view` padding |
| `--tg-space-5` | `20px` | Wide-screen pane padding (`≥1400px`) |
| `--tg-radius-sm` | `6px` | Buttons, inputs, tab buttons |
| `--tg-radius-md` | `8px` | Cards, `.botrow` |
| `--tg-radius-lg` | `10px` | Panes, `.panel-view`, modal |
| `--tg-radius-pill` | `12px` / `9px` | `.pill`, `.tag` |
| `--tg-elev-0` | `none` | Panes (flat, border-only) |
| `--tg-elev-1` | `border: 1px solid` | Cards, panel views |
| `--tg-elev-2` | `border + box-shadow` | Modal overlay backdrop (`rgba(0,0,0,.65)`) |
| `--tg-elev-modal` | `position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 50` | Modal (from `app/style.css`) |

#### 13.2.6 Density modes

| Token | `compact` (default, operators) | `comfortable` (tablet review, phone approvals) |
|---|---|---|
| `--tg-row-py` | `3px` | `8px` (`.row { padding: 8px 6px }` from responsive.css) |
| `--tg-row-px` | `4px` | `6px` |
| `--tg-pane-padding` | `8px 10px` (`.pane-body`) | `10px 12px` |
| `--tg-btn-py` | `5px 10px` | `10px 16px` (min-height 44px) |
| `--tg-font-base` | `13px` | `14px` (mobile iOS-zoom prevention: `font-size: 16px` on inputs) |
| `--tg-chat-height` | `220px` (fixed) | `auto; max-height: 40dvh` |

Density is toggled via a `--tg-density` custom property on `<body>` or `.shell`. Operators (the primary use case) live in `compact` by default. `comfortable` is applied automatically on touch-only devices (`@media not ((hover: hover) and (pointer: fine))`) and can be manually toggled.

#### 13.2.7 Iconography rules

- **No icon library.** The console uses Unicode glyphs (▲, ✓, ✖) and CSS-drawn shapes (`.dot` circles, `.pill` capsules) only.
- **Status dots** (`.dot`): `width: 9px; height: 9px; border-radius: 50%` — live indicator only. `.dot.on` = `--tg-state-ok` with `box-shadow: 0 0 6px #58d68d`. `.dot.off` = `--tg-state-blocked`.
- **Chain pill** (`.pill.sealed` / `.pill.tambered`): `padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700` — carries text label (SEALED ✓ / TAMPERED ✖) as the primary meaning, color as secondary.
- **SVG icons** (PWA): `/icons/icon-192.svg`, `/icons/icon-512.svg`, `/icons/icon-maskable.svg` — used for install/maskable only; not inline in the console.

#### 13.2.8 Dark-first with light parity

The default `:root { color-scheme: dark }` establishes the dark palette. Light parity is defined via:

```css
@media (prefers-color-scheme: light) {
  :root { color-scheme: light; }
  --tg-bg-base: #f6f8fa;
  --tg-bg-surface: #ffffff;
  --tg-bg-elevated: #ffffff;
  --tg-border: #d0d7de;
  --tg-border-strong: #afb8c3;
  --tg-text: #1f2328;
  --tg-text-bright: #0f1419;
  --tg-text-muted: #656d76;
  /* risk tokens keep their hue; backgrounds shift to pastel */
  --tg-risk-read-bg: #ddf4ff;
  --tg-risk-write-bg: #fff8c5;
  --tg-risk-destructive-bg: #ffeef0;
  --tg-risk-secret-bg: #f3e8ff;
}
```

Light mode preserves **every** semantic token name and contrast ratio (≥ 4.5:3 for normal text, ≥ 3:1 for large text). Risk token hues are unchanged (color semantics are mode-agnostic); only background fills shift to pastel equivalents.

### 13.3 Code block — complete `--tg-*` token table

```css
:root {
  /* ── Surface scale ── */
  --tg-bg-base:          #0b0e14;
  --tg-bg-surface:       #0d1117;
  --tg-bg-elevated:      #11151f;
  --tg-bg-hover:         #161b26;
  --tg-border:           #21262d;
  --tg-border-strong:    #30365d;
  --tg-text:             #c9d1d9;
  --tg-text-bright:      #e6edf3;
  --tg-text-muted:       #8b949e;

  /* ── Risk palette ── */
  --tg-risk-read:        #79c0ff;
  --tg-risk-read-bg:     #1c2a3a;
  --tg-risk-write:       #e3b341;
  --tg-risk-write-bg:    #332a12;
  --tg-risk-destructive: #f85149;
  --tg-risk-destructive-bg:#3a1c1c;
  --tg-risk-secret:      #d2a8ff;
  --tg-risk-secret-bg:   #2a1c3a;

  /* ── State colors ── */
  --tg-state-ok:         #58d68d;
  --tg-state-blocked:    #f85149;
  --tg-state-pending:    #e3b341;
  --tg-state-unknown:    #8b949e;

  /* ── Type scale ── */
  --tg-text-xs:          10px;
  --tg-text-sm:          11px;
  --tg-text-base:        13px;
  --tg-text-md:          14px;
  --tg-text-lg:          15px;
  --tg-text-xl:          18px;
  --tg-text-mono:        ui-monospace, Menlo, Consolas, monospace;

  /* ── Spacing ── */
  --tg-space-1:          4px;
  --tg-space-2:          8px;
  --tg-space-3:          12px;
  --tg-space-4:          16px;
  --tg-space-5:          20px;

  /* ── Radius ── */
  --tg-radius-sm:        6px;
  --tg-radius-md:        8px;
  --tg-radius-lg:        10px;
  --tg-radius-pill:      12px;

  /* ── Elevation ── */
  --tg-elev-modal:       rgba(0,0,0,.65);
}
```

### 13.4 Component primitives catalog

#### Badge (`.tag`)

**Anatomy:** Inline pill with `padding: 1px 7px; border-radius: 9px; font-size: 10px; white-space: nowrap;`. Contains a text label (the `type` string from the audit entry).

**Variants:** `.tag.decision` (read/allow), `.tag.exec` (executed), `.tag.approval` (approval_requested/approval_resolved), `.tag.deny` (auth_rejected), `.tag.chat` (chat_action), `.tag.other` (genesis/unknown). Each variant carries both a background fill and a foreground color.

**States:** Badge text is the source of truth. No badge-only state — state is communicated by the `.dec` sibling text token or the `.tag` class itself. A `.tag.deny` always renders "deny" as text; it never relies on color alone.

#### State dot (`.dot`)

**Anatomy:** `width: 9px; height: 9px; border-radius: 50%; display: inline-block;`. No text content — purely decorative, **always** accompanied by a text label (the `.pill` text "SEALED ✓" / "TAMPERED ✖", or the `title="SSE connection"` attribute, or the `chainPill` textContent).

**Variants:** `.dot.on` (`background: #58d68d; box-shadow: 0 0 6px #58d68d`), `.dot.off` (`background: #f85149`).

**States:** `on` = verified/live. `off` = tampered/disconnected. Never a third state — "pending" uses `.pill` with amber, not a dot.

#### Risk chip

**Anatomy:** A `.tag` or inline element carrying a risk class label with its background fill. The chip's meaning is: (a) color, (b) background fill, (c) text label — all three present.

**Variants:** `read` (blue), `write` (amber), `destructive` (red), `secret` (purple). Source: `src/gateway/policy.js` `CLASSIFICATIONS`.

**States:** Static classification — a risk chip does not change state; it identifies the class. When a `destructive` action is approved, the subsequent `.tag.exec` (green) replaces the risk chip, communicating the transition via a different component, not a color swap on the same element.

#### Chain-ref (hash ref)

**Anatomy:** `<code>` element with `--tg-text-mono` font, color `--tg-text-muted` (or `--tg-risk-blocked` when tampered). Displays the **8-character short form** (first 8 hex chars of the SHA-256) as the default; the full 64-char hash is available via `title` attribute or copy interaction.

**Variants:** Normal hash (`#e.seq + ' ' + hash.slice(0,8)`), head hash (`String(v.head).slice(0, 12)`), prev-hash reference.

**States:** Normal = `--tg-text-muted`. Tampered/invalid = `--tg-state-blocked` (red). Unverified = `--tg-state-unknown` (gray). The chain verify result drives the state: `app/app.js` `setPill` sets the pill text AND color from `chain.verify()`.

#### Key-hint (`.kbd-hints`)

**Anatomy:** Inline flex container `gap: 10px; align-items: center; color: #8b949e; font-size: 11px`. Only visible on devices with fine pointer + hover (`@media (hover: hover) and (pointer: fine)`). Hidden on touch devices (`kbd { display: none }`).

**Variants:** Keyboard shortcuts shown as `<kbd>` elements: `padding: 1px 6px; border: 1px solid #30365d; border-bottom-width: 2px; border-radius: 5px; background: #161b26; color: #79c0ff; font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace`.

**States:** Visible (desktop) / hidden (touch). The `<kbd>` rendering is a **hint**, not a required interaction path — all keyboard shortcuts must also be accessible via on-screen controls (button elements).

#### Empty state (`.empty`, `.panel-placeholder`)

**Anatomy:** `color: #8b949e; padding: 14px; text-align: center; font-style: italic` (`.empty`). For panels: `.panel-placeholder` = `.panel-view.panel-placeholder` with a "panel not loaded: {id}" message.

**Variants:** "none" (no pending approvals), "connect a token" (unconnected), "panel not loaded: {id}" (lazy panel not yet mounted), "no entries yet" (empty audit chain).

**States:** Empty states are **informational**, not error screens. They never imply failure — they communicate absence of data. The `.panel-placeholder` specifically indicates a lazy-loaded panel that hasn't been mounted yet (not an error).

#### Untrusted block (`.msg.action`)

**Anatomy:** Chat message variant for LLM-proposed actions: `align-self: flex-start; background: #332a12; border: 1px solid #6b5217; color: #e3b341`. Contains the tool name and decision text, plus an optional approve button (rendered as a `.btn.ok` element, not inline HTML).

**Variants:** The untrusted block wraps LLM output that has been routed through `classify()`/`decide()` but is **not yet executed**. It is visually distinguished from both human messages (`.msg.me`, gray) and bot replies (`.msg.bot`, dark). The border color (`#6b5217`) and text color (`#e3b341`) both encode the "needs approval" state.

**States:** Pending approval (shows approve button), approved/denied (button replaced with status text). The block's entire purpose is to make the trust boundary visible: the model's output is UNTRUSTED text that may PROPOSE at most one action (llm-brain.js). The block makes this boundary explicit.

---

## §14 Accessibility

### 14.1 WCAG 2.2 AA targets per component class

| Component class | Target | Criterion | Status |
|---|---|---|---|
| Body text (`.text`, `.row`, `.card-reason`) | ≥ 4.5:1 contrast | 1.4.3 | ✅ `--tg-text` #c9d1d9 on `--tg-bg-base` #0b0e14 = 12.6:1 |
| Large text / headings (`.brand`, h1, h2, h3) | ≥ 3:1 contrast | 1.4.3 | ✅ `--tg-text-bright` #e6edf3 on `--tg-bg-surface` #0d1117 = 13.5:1 |
| Interactive elements (`.btn`, `.tab`, `.pill`) | ≥ 3:1 against adjacent | 1.4.11 | ✅ `--tg-text` variants on `--tg-bg-elevated` |
| Focus indicator | ≥ 3:1 against background | 2.4.7 | ⚠️ Not yet defined in CSS — see §14.3 |
| Non-text content (`.dot`, `.pill`) | ≥ 3:1 against adjacent | 1.4.11 | ✅ Dot colors have 6px glow + text label |
| Link text (`.foot a`) | ≥ 4.5:1 | 1.4.3 | ✅ #79c0ff on #0b0e14 = 8.2:1 |

**Level-AAA where feasible:** Body text contrast in dark mode (12.6:1) exceeds AAA's 7:1 for normal text. The spec targets AA as the floor but delivers AAA-level contrast in the default dark palette.

### 14.2 Keyboard-only operation — MUST for approval queue and command palette

**This is an ops product; mouse-only approval = MUST NOT.** The approval queue (`app/app.js` `refreshPending` / `resolve`) and any future command palette MUST be fully operable from keyboard alone.

**Current approval queue (keyboard mapping):**
- `Tab` / `Shift+Tab`: move focus between approval cards and action buttons
- `Enter` or `Space`: activate the focused approve/deny button
- Each card has two `<button>` elements (`approve`, `deny`) — natively focusable and activatable
- The `resolve()` function fires on `click`, which is also triggered by `Enter`/`Space` on `<button>` elements — no custom key handler needed for native buttons

**Must-add for command palette (future):**
- `/` key: open command palette (focus trap within)
- `Escape`: close palette, return focus to previously focused element
- `ArrowUp`/`ArrowDown`: navigate command list
- `Enter`: execute selected command
- All command actions must have visible `<button>` fallbacks inside the palette

**MUST NOT:** A modal or drawer that traps focus but cannot be dismissed by `Escape`. A dropdown that opens on hover but has no keyboard trigger. Any approval action that requires a mouse click exclusively.

### 14.3 Screen-reader contracts — live regions (SSE feed updates)

The SSE stream (`/v2/events`) delivers audit entries as `event: audit` frames. Each entry is a live region update. The contract specifies **aria-live** politeness per event class:

| Event class | aria-live | Rationale | Source |
|---|---|---|---|
| `approval_requested` | **assertive** | A human must act; delay is harmful | `app/app.js` SSE handler + `refreshPending()` |
| `approval_resolved` | **assertive** | Resolution changes state; must be announced | Same |
| `action_decision` | **polite** | Info-level, no action required | SSE stream row prepend |
| `action_executed` | **polite** | Info-level, no action required | SSE stream row prepend |
| `action_executed_after_approval` | **polite** | Post-approval execution, informational | SSE stream row prepend |
| `auth_rejected` | **assertive** | Security event, requires attention | `server.js` audit |
| `genesis` | **polite** | Chain initialization, informational | `hash-chain.js` |
| `hello` (SSE connect) | **polite** | Connection confirmed, not an action | `events.js` |
| `pending` (broadcast) | **assertive** | New approval arrived | `events.js` `broadcast('pending', ...)` |

**Implementation rule:** Each live region must be a separate DOM element with `aria-live={polite|assertive}` and `aria-atomic="true"`. The stream feed container uses `aria-live="polite"` for the append-only log; the approval count (`#pendingCount`) updates with `aria-live="assertive"` when it changes. Approval cards render with `role="alert"` when newly appended.

### 14.4 Risk info in text, not color only

**Every** risk indicator carries its meaning in text:
- Risk class: `.tag` element renders the type string (e.g., "destructive", "write") as text content
- Decision: `.dec` element renders `allow`, `needs_approval`, or `deny` as text
- Chain state: `.pill` renders "SEALED ✓" or "TAMPERED ✖" as text
- Approval status: countdown renders "expires in 42s" or "expired" as text
- Provider status: `probeLlm` returns `{detail: 'not_configured' | 'reachable' | 'reachable_but_unknown' | 'unreachable'}` — all strings, rendered as text in the Providers panel

**Never** rely on color alone. The `.dot.on`/`.dot.off` dots are accompanied by the `.pill` text label and the `title` attribute. The `.tag.deny` class is always paired with the text "deny".

### 14.5 Focus management — modals, drawers, takeovers

| Surface | Focus behavior | Source |
|---|---|---|
| Modal (`.modal`) | Focus moves to first focusable element inside; `Escape` closes; focus returns to trigger element | `app/style.css` `.modal { position: fixed; inset: 0; z-index: 50 }` |
| Drawer (future) | Focus trap within drawer; `Escape` dismisses; focus returns to trigger | To be implemented |
| Tab switch (`core.js` `switchTab`) | Focus stays on the tab button (no forced move); new panel content does NOT steal focus | `app/panels/core.js` |
| Approval card resolution | Focus stays on the card's button row after resolution (visual feedback via `.card.done` opacity change, not focus theft) | `app/app.js` `resolve()` |
| Command palette (future) | Focus trap; `Escape` returns focus to trigger | To be implemented |

**MUST:** No focus theft on tab switch. The `core.js` `switchTab` correctly does NOT move focus — the active tab button retains focus.

### 14.6 Reduced motion — `prefers-reduced-motion: reduce`

**Global rule:** `@media (prefers-reduced-motion: reduce)` disables all animations and transitions. The `responsive.css` already defines: `.row { animation: none }` (drops the flash animation). The spec extends this:

| Animation | Normal | Reduced-motion variant |
|---|---|---|
| `.row` flash (1.2s ease-out) | `animation: flash 1.2s ease-out` | `animation: none` — row appears instantly |
| SSE new-turn slide | Slide-in transition (§17 timing table) | Instant appearance (opacity: 1, no transform) |
| Countdown tick | `setInterval` 1s update | Unchanged — countdown is a text update, not motion |
| `prefers-reduced-motion` cascade | — | All `--tg-*` transition durations collapse to `0ms`; all `@keyframes` are `none` |

**Implementation:** Add a global `@media (prefers-reduced-motion: reduce)` block that sets `--tg-transition-duration: 0ms` and overrides every `animation` and `transition` property. The `responsive.css` `.row { animation: none }` rule is the seed; the global block extends it to all animated surfaces.

### 14.7 Contrast table — risk palette

| Token | Foreground | Background | Ratio | AA (4.5:1) | AAA (7:1) |
|---|---|---|---|---|---|
| `--tg-risk-read` | #79c0ff | #0b0e14 | 8.2:1 | ✅ | ✅ |
| `--tg-risk-write` | #e3b341 | #0b0e14 | 5.8:1 | ✅ | ❌ |
| `--tg-risk-destructive` | #f85149 | #0b0e14 | 5.1:1 | ✅ | ❌ |
| `--tg-risk-secret` | #d2a8ff | #0b0e14 | 9.1:1 | ✅ | ✅ |
| `--tg-state-ok` | #58d68d | #0b0e14 | 7.2:1 | ✅ | ✅ |
| `--tg-state-blocked` | #f85149 | #0b0e14 | 5.1:1 | ✅ | ❌ |
| `--tg-text` | #c9d1d9 | #0b0e14 | 12.6:1 | ✅ | ✅ |
| `--tg-text-muted` | #8b949e | #0b0e14 | 4.6:1 | ✅ | ❌ |
| `--tg-text-muted` on `--tg-bg-elevated` | #8b949e | #11151f | 5.9:1 | ✅ | ❌ |

**Note:** `--tg-text-muted` on `--tg-bg-base` is 4.6:1 — barely AA. For small text, ensure `--tg-text-muted` is never used below 11px on `--tg-bg-base` without a background fill. The tag backgrounds (`#1c2a3a`, `#332a12`, `#3a1c1c`, `#2a1c3a`) provide sufficient contrast with their foreground colors.

### 14.8 Testing bar — CI validation

| Test | Tool | Target | CI status |
|---|---|---|---|
| Automated a11y audit | **axe-core** | All `.panel-view`, `.modal`, `.card` surfaces | ⛔ **BACKEND GAP: no CI yet** — mark |
| Keyboard-only smoke | Manual + automated (jest-axe + jsdom) | Approval queue, tab router, command palette | ⛔ **BACKEND GAP: no CI yet** — mark |
| Screen-reader smoke | NVDA/VoiceOver manual | Live region announcements, approval arrivals, chain verify | ⛔ **BACKEND GAP: no CI yet** — mark |
| Contrast validation | `contrast-checker` or `axe` | All `--tg-*` tokens on their backgrounds | ⛔ **BACKEND GAP: no CI yet** — mark |
| Reduced-motion | `prefers-reduced-motion` emulation | All animations collapse to 0ms | ⛔ **BACKEND GAP: no CI yet** — mark |

**BACKEND GAP: No CI pipeline exists.** The platform has 611 tests (PLATFORM-ABI) but no CI integration. The testing bar is a specification target, not a current capability. Implement via `node --test tests/*.test.js` (existing pattern) extended with axe-core and keyboard smoke tests.

### 14.9 Acceptance criteria (§14)

1. Every risk class (read/write/destructive/secret) renders its type as **visible text**, never color-only — verifiable by inspecting DOM textContent.
2. Approval queue is fully operable via `Tab`/`Enter`/`Space` with no mouse-only actions — verifiable by removing all mouse event listeners and confirming all buttons remain activable.
3. `approval_requested` and `approval_resolved` SSE events use `aria-live="assertive"` — verifiable by inspecting the live region element's attribute.
4. All other SSE events use `aria-live="polite"` — verifiable by attribute inspection.
5. `prefers-reduced-motion: reduce` collapses all animations to `0ms`/`none` — verifiable by computed style inspection with the media query forced.
6. `.dot.on`/`.dot.off` are always accompanied by a text label — verifiable by sibling DOM check.
7. Focus is never stolen on tab switch — verifiable by recording `document.activeElement` before and after `switchTab`.
8. Modal is dismissible by `Escape` — verifiable by key event dispatch.
9. Contrast ratio for all `--tg-text` tokens on their backgrounds meets ≥ 4.5:1 — verifiable by automated contrast check.
10. Chain state ("SEALED ✓" / "TAMPERED ✖") is rendered as text in `.pill` — verifiable by `textContent` check.
11. All 5 testing-bar items (axe, keyboard, SR, contrast, reduced-motion) have a defined target and a `BACKEND GAP: no CI yet` marker — verifiable by document inspection.

---

## §15 Responsive / cross-device

### 15.1 Device classes

| Device class | Primary use | CSS / layout anchor | Density |
|---|---|---|---|
| **Desktop ops** | Operator console, 3-pane grid | `app/style.css` `.panes` grid, `desktop.css` `≥1400px` 4-col | Compact |
| **Tablet** | Manager review, overview | `responsive.css` `≤800px` single column | Comfortable |
| **Phone** | Approver on-call + chat | `responsive.css` `≤800px`, `landscape ≤500px` 2-col | Comfortable (44px tap targets) |
| **Terminal / TUI** | Operators headless | `bin/tg.js` + `src/cli/` — parity spec below | Compact |

### 15.2 Terminal / TUI — bin/tg.js parity spec

The CLI/TUI surface (`bin/tg.js`, `src/cli/`) is the **headless companion** to the browser console. It MUST support every operation an operator performs in the browser, including approvals, because the terminal is the fallback when the browser is unavailable (e.g., SSH-only ops).

**MUST be possible headless:**
- `tg status` — chain verify (`/v1/audit/verify`), entry count, head hash, pending count
- `tg pending` — list pending approvals (id, bot, tool, reason, expiresAt)
- `tg approve <id>` — approve by ID (`POST /v1/approvals/<id>/approve`)
- `tg deny <id>` — deny by ID (`POST /v1/approvals/<id>/deny`)
- `tg stream` — follow the SSE audit feed in terminal output (or poll `/v1/audit?since=`)
- `tg bots` — list workforce bots and capabilities
- `tg chat <message>` — send a chat message (`POST /v2/chat`)
- `tg auth <token>` — set bearer token

**MUST NOT:** Any operation that the browser console can perform must be impossible from the terminal. The approval flow is the critical parity point — an operator must be able to approve/deny from the terminal when the browser is unreachable.

**Source:** `bin/tg.js` is the CLI entry point (owned by W7 CLI/TUI, branch v2/cli). `server.js` exposes all approval endpoints. `app/app.js` is the browser reference implementation.

### 15.3 Desktop mode — PWA install (wave C artifacts)

The console is a PWA (`app/manifest.webmanifest`, `app/sw.js`, `app/offline.html`). Install on desktop:

1. Open `http://127.0.0.1:8787` (or configured port).
2. Browser install prompt or "Install page as app" from menu.
3. Generated launcher artifact: `GET /v2/deploy/artifact?kind=launcher` (bearer) returns a `.desktop` entry — save to `~/.local/share/applications/trust-gateway.desktop`, run `update-desktop-database`. This is the **only generated artifact**; Windows/macOS use manual install steps (deploy/cloud.md).
4. The PWA manifest (`manifest.webmanifest`) declares `display: "standalone"`, `background_color: "#0b0e14"`, `theme_color: "#0d1117"`.

### 15.4 Composition engine — device axis formalized

The Dynamic UI Composition engine (§5 reference) selects surfaces by the **device axis**. Each device class maps to a **surface stack**:

| Device class | Surface stack (primary → secondary) | Composition rule |
|---|---|---|
| Desktop ops | Feed → Board → Graph → Detail → Queue | Full 3-pane grid; graph is a relationship view; queue is the approval worklist |
| Tablet | Feed → Detail → Queue | Graph **collapses to list-detail** (no spatial graph on tablet); board collapses to a timeline |
| Phone | Queue → Detail → Feed | **Approvals stay first-class** — the approval queue is the primary surface on phone because "approvals are the killer mobile use." Graph collapses to a linear chain of nodes. Board collapses to a scrollable list. |
| Terminal/TUI | Queue → Stream → Detail | No graph, no board. Linear text stream + approval list. |

**Key rule: approvals stay first-class on phone.** The approval queue (`#panePending`) is always a primary surface regardless of device class. On desktop it's one of three panes; on phone it becomes the **first** surface (the killer mobile use case: an approver on-call receiving and resolving approvals from a phone). This is not an aspiration — it is a composition rule derived from the product's nature as an ops tool where human approval gates are the critical path.

### 15.5 PWA offline stance

| Resource | Offline stance | Source |
|---|---|---|
| App shell (`index.html`, `app.js`, `style.css`, `responsive.css`, `desktop.css`) | **Cached** (service worker `SHELL_CACHE`) | `app/sw.js` |
| Audit stream / approvals / SSE data | **Never cached** — always network-first | `app/sw.js` `if (url.pathname.startsWith('/v1/') || ...)` |
| Offline fallback | `/offline.html` — "Trust Gateway is offline. The audit chain, approvals, and live stream all require a connection." | `app/offline.html` |
| Read-only evidence view | **Cached and viewable** — historical audit entries in the local cache are viewable offline | `app/sw.js` shell cache |

**Critical rule — approvals MUST NOT submit blind offline.** When the gateway is unreachable:
1. The UI detects staleness via SSE `onerror` (`$('liveDot').className = 'dot off'`).
2. The approval queue shows a **stale-state banner**: "Approvals paused — gateway unreachable. Stale-state detected. Approvals require a live connection."
3. No approval is submitted from cached state. The `resolve()` function calls `api('/v1/approvals/' + id + '/' + verb, { method: 'POST' })` — this **requires network**. If network is absent, the fetch rejects and the card shows "failed" (not a silent offline submission).
4. Stale-state detection: compare the local chain head hash against the last-known server head. If the gap exceeds `N` entries (configurable, default 5), flag as stale. Source: `events.js` `hello` event provides `{head, seq, chainId}` on connect.

### 15.6 PWA install and update flow

**Install:**
1. Service worker registers (`sw.js`).
2. `beforeinstallprompt` fires (browser-dependent).
3. User installs → PWA launches as standalone window with `manifest.webmanifest` assets cached.
4. `.desktop` launcher generated via `/v2/deploy/artifact?kind=launcher` (Linux).

**Update:**
1. New `VERSION` constant in `sw.js` (`trust-gateway-v2-pwa-w9.0.0`).
2. On load, SW checks for updated shell cache.
3. `skipWaiting` + `clients.claim()` on activate.
4. Old caches deleted (`keys.filter(k => k.startsWith('tg-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))`).
5. **API data is never updated from cache** — the service worker never serves stale audit/approval data. The update only applies to the app shell.

### 15.7 Acceptance criteria (§15)

1. Desktop ops renders the 3-pane grid; `≥1400px` switches to 4-column via `desktop.css`.
2. `≤800px` collapses to single column with `100dvh` and safe-area insets.
3. All tap targets on phone/tablet are `≥ 44×44px` — verifiable by computed `min-height`/`min-width`.
4. The terminal `tg pending` / `tg approve <id>` / `tg deny <id>` commands are spec-defined and implementable with existing API endpoints.
5. Approvals are the **primary** surface on phone (first-class), not demoted to a secondary tab.
6. Offline mode serves the cached app shell + `offline.html`; API data is never served from cache.
7. Stale-state detection compares local chain head against server head; gap > 5 flags a visible stale banner.
8. Approvals cannot be submitted while offline — the `resolve()` fetch rejects and displays "failed".
9. PWA update rotates `VERSION` constant; old shell caches are purged on activate.
10. The `.desktop` launcher artifact is generated via `GET /v2/deploy/artifact?kind=launcher`.

---

## §16 Failure & recovery UX — failure as object-state, not dead screens

### 16.1 Design principle

Failure is a state of the object, never a dead-end screen (00-KERNEL principle 6). Every failure class maps to an **audit event type** (the UI's ground truth) and renders as an object with a state, not as a full-page error. The user sees the failed object in its degraded state, with recovery actions offered inline.

### 16.2 Failure taxonomy from this codebase

#### Class A: Provider 402-exhausted / 429 rate-limited (the war story)

**Detection:** `llm-brain.js` `postJson` → `httpProbe` returns HTTP status. `402` (payment required, Dialagram quota exhausted) and `429` (rate limited) both arrive as `status >= 300` → `throw llmError('llm_http_error', status)`. The `chat()` method catches the error: `bubble.textContent = err.status === 404 ? 'chat unavailable' : 'chat error'`.

**User-facing surface (exact wording pattern):**
- `da:` "Modellen er utilgængelig lige nu — falder tilbage. Prøv igen, eller brug den deterministiske planlægger på POST /v2/chat."
- `en:` "The model is unavailable right now — falling back. Try again, or use the deterministic planner at POST /v2/chat."
- The chat bubble shows `…` (loading) then transitions to the fallback reply text. The fallback is **visible** — the user sees "falling back" explicitly.

**Recovery actions offered:**
- "Try again" — re-submit the message (idempotent retry).
- "Use deterministic planner" — navigate to POST /v2/chat (the fallback path).
- If 429: automatic backoff with exponential retry (SHOULD, not yet implemented — BACKEND GAP).

**Never silently retried:** The 402/429 error is **not** silently retried. The user sees the fallback message. Non-idempotent retries (re-submitting a chat that already executed a destructive action) are NEVER retried automatically.

**Source:** `llm-brain.js` `UNAVAILABLE_REPLY`, `chat()` error handler, `postJson` `req.setTimeout(timeoutMs, () => { req.destroy(); fail(llmError('llm_timeout')) })`.

#### Class B: LLM fallback chain visible + honest backend labels

**Detection:** `llm-brain.js` `chat()` catches errors and returns `{fallback: true, reply: <replacement>, error: <code>, actions: []}`. The fallback chain is: `llm_not_configured` → `UNSET_REPLY`; `llm_timeout` / `llm_network` / `llm_http_error` / `llm_bad_response` / `llm_empty_response` → `UNAVAILABLE_REPLY`; empty response → `EMPTY_REPLY`.

**User-facing surface:** Each fallback code maps to a specific, honest label:
- `llm_not_configured`: "LLM brain not configured — set TG_LLM_BASE_URL / TG_LLM_KEY / TG_LLM_MODEL. Deterministic chat remains available at POST /v2/chat."
- `llm_timeout`: "The model is unavailable right now — falling back." (via `UNAVAILABLE_REPLY`)
- `llm_network`: Same as above.
- `llm_http_error` (status-specific): The status code is logged server-side; the user sees the generic "falling back" message.
- `llm_bad_response`: Same as above.
- `llm_empty_response`: "The model returned an empty response — nothing to act on."

**Recovery actions:** "Use deterministic planner at POST /v2/chat" is present in every fallback message. The deterministic planner (`src/gateway/chat-singleton.js`) is the always-available fallback.

**Never silently retried:** Each fallback is a single attempt. The model is not retried automatically — the user must explicitly retry.

**Source:** `llm-brain.js` `UNSET_REPLY`, `UNAVAILABLE_REPLY`, `EMPTY_REPLY`, `chat()` catch block.

#### Class C: Chain-verify broken → SECURITY red state (blocks approvals MUST)

**Detection:** `hash-chain.js` `verify()` returns `{ok: false, at, reason}` where `reason ∈ {seq_gap, bad_genesis_prev, prev_hash_mismatch, hash_mismatch}`. `server.js` `GET /v1/audit/verify` and `GET /healthz` return the verify result. `app/app.js` `setPill(v.ok)` sets the pill to TAMPERED if `ok: false`.

**User-facing surface:**
- `da:` "Kæden er TAMPERET ✖. Godkendelse blokeret. Kontakt sikkerhed."
- `en:` "Chain is TAMPERED ✖. Approvals blocked. Contact security."
- The `.pill.tambered` renders "TAMPERED ✖" in red (`#f85149`).
- All approval buttons are **disabled** (MUST — a tampered chain means the audit trail is untrustworthy; approvals must not proceed on a compromised ledger).
- The chain-ref for the invalid entry renders in `--tg-state-blocked` (red).

**Recovery actions:**
- "Verify chain" — re-run `/v1/audit/verify` (idempotent check).
- "Export audit log" — export the chain for offline forensics.
- "Contact security" — the only recovery for a genuine tamper is human investigation.

**Never silently retried:** A tampered chain is NEVER auto-recovered. The chain is append-only; verification failure means something is wrong and must be investigated. No automatic retry, no bypass.

**Source:** `hash-chain.js` `verify()`, `server.js` `_postApproval` (approvals check `canApprove(bot)` — extend to check chain verify), `app/app.js` `setPill`.

#### Class D: Playground timeout

**Detection:** `playground.js` `runSnippet` spawns a child process with `timeoutMs` (default `DEFAULT_TIMEOUT_MS = 3000`). If the process exceeds the timeout, it receives `SIGKILL`. The audit event is `playground_run {bot, lang, bytes, exitCode, timedOut}`.

**User-facing surface:**
- `da:` "Kørslen timeoutede efter 3s. Koden blev afbrudt (SIGKILL). Prøv igen med en kortere løsning."
- `en:` "Run timed out after 3s. Code was killed (SIGKILL). Try again with a shorter solution."
- The playground panel shows the timeout event in the stream with `timedOut: true`.

**Recovery actions:**
- "Retry" — re-submit the snippet (idempotent — the sandbox process is fresh each time).
- "Reduce code size" — hint that code ≤ 8000 bytes.
- "Increase memory" — hint that default is 64MB.

**Never silently retried:** Playground runs are non-idempotent (they execute user code in a sandbox). A timeout is NEVER silently retried — the user must explicitly retry, and each retry spawns a new process.

**Source:** `playground.js` `DEFAULT_TIMEOUT_MS`, `SIGKILL`, `MAX_CODE_BYTES = 8000`.

#### Class E: Adapter probe fail / blocked-SSRF

**Detection:** `adapters.js` `probe()` returns `{id, kind, result: ok|fail|blocked}`. `_probeWebhook` and `_probeHttpApi` check `isPrivateAddress(hostnameOf(url))` → `{result: 'blocked', error: 'private_address'}` (SSRF refusal). Network errors → `{result: 'fail'}`. The probe runs with `PROBE_TIMEOUT_MS = 8000`.

**User-facing surface:**
- `da:` "Probe blokeret: privat adresse (SSRF-forbud)." / "Probe mislykkedes: {error}."
- `en:` "Probe blocked: private address (SSRF refusal)." / "Probe failed: {error}."
- The adapter card shows `result: 'blocked'` (red) or `result: 'fail'` (amber) with the `error` string as text.
- The fingerprint (`first 12 hex of sha256`) is shown as text for secret verification — never the secret itself.

**Recovery actions:**
- "Re-probe" — re-run the probe (idempotent — it's a network check).
- "Check URL" — verify the endpoint is publicly reachable.
- "Use different integration" — switch to another adapter kind.

**Never silently retried:** The SSRF block is a security decision, not a transient error. It is NEVER retried automatically. A `blocked` result requires a human to change the target URL.

**Source:** `adapters.js` `isPrivateAddress`, `probe()`, `_probeWebhook`, `_probeHttpApi`, `PROBE_TIMEOUT_MS`.

#### Class F: Gateway unreachable — SSE gap detection + resync banner

**Detection:** `app/app.js` `es.onerror` → `$('liveDot').className = 'dot off'`. The SSE `EventSource` connection drops. The `hello` event (which provides `{head, seq, chainId}`) is the resync anchor. Gap detection: if the local `entryCount` exceeds the server's `seq`, there is a gap.

**User-facing surface:**
- `da:` "Gateway utilgængelig — SSE tilkobring brudt. Visning af sidste kendte stand. Klik for at genoprette."
- `en:` "Gateway unreachable — SSE connection broken. Showing last known state. Click to resync."
- The `liveDot` turns red (`.dot.off`). A resync banner appears at the top of the stream pane.
- The chain pill remains in its last known state (SEALED or TAMPERED) until reconnection.

**Recovery actions:**
- "Resync" — re-fetch `/v1/audit?since=<lastKnownSeq>` and re-establish SSE connection.
- "Retry connect" — re-run `connect()` (re-establishes `EventSource` and re-verifies chain).
- "View offline" — navigate to the cached evidence view (read-only).

**Never silently retried:** The SSE reconnection is automatic (the browser `EventSource` retries with `retry: 3000` from `events.js`), but **approval actions are never silently retried during reconnection**. The approval queue shows "gateway unreachable" and disables buttons until reconnection.

**Source:** `app/app.js` `es.onerror`, `es.onopen`, `es.addEventListener('audit')`, `events.js` `retry: 3000`.

#### Class G: Partial write failure

**Detection:** `server.js` `_audit(payload)` calls `this.chain.append(payload)` + `disk.appendTo(this.auditFd, entry)` + `this.emit('audit', entry)`. If `disk.appendTo` fails (disk full, permission error), the chain append succeeds but the durable write fails. The `_postAction` catch block emits `{type: 'action_executed', ok: false, error: String(e && e.message)}`.

**User-facing surface:**
- `da:` "Handling blev besluttet men kvitterede ikke — delvis skrivning. Audit-kæden er intakt, men den durable optegnelse mangler en post."
- `en:` "Action decided but not confirmed — partial write. The audit chain is intact, but the durable log is missing an entry."
- The action appears in the in-memory chain (verified) but flagged with a "partial write" indicator.

**Recovery actions:**
- "Re-verify chain" — run `/v1/audit/verify` to confirm chain integrity.
- "Replay from disk" — reload the durable log and reconcile with the in-memory chain.
- "Export audit log" — export for offline reconciliation.

**Never silently retried:** A partial write is NEVER silently retried — the chain is append-only and the write either succeeded or it didn't. The user must reconcile manually. The `_audit` method emits the audit event regardless of disk status (the in-memory chain is the source of truth; the disk is the durable backup).

**Source:** `server.js` `_audit`, `_postAction` catch, `disk-audit.js`.

### 16.3 Failure-state summary table

| Class | Detection | User-facing (en) | Recovery | Never silently retried |
|---|---|---|---|---|
| A: 402/429 | `llm_http_error` status | "The model is unavailable right now — falling back." | Try again / Use deterministic planner | Yes — fallback is visible, no auto-retry |
| B: LLM fallback chain | `chat()` catch → `{fallback: true}` | Honest backend label per code | Use deterministic planner | Yes — single attempt |
| C: Chain-verify broken | `verify() {ok: false}` | "Chain is TAMPERED ✖. Approvals blocked." | Verify / Export / Contact security | Yes — never auto-recovered |
| D: Playground timeout | `SIGKILL` after `timeoutMs` | "Run timed out after 3s. Code was killed." | Retry / Reduce code / Increase memory | Yes — non-idempotent |
| E: Adapter probe fail/block | `probe() → {result: 'blocked'|'fail'}` | "Probe blocked: private address (SSRF refusal)." | Re-probe / Check URL / Switch adapter | Yes — SSRF block is security, not transient |
| F: Gateway unreachable | `es.onerror` → `dot.off` | "Gateway unreachable — SSE connection broken." | Resync / Retry connect / View offline | Approvals disabled; SSE auto-reconnects |
| G: Partial write failure | `_audit` disk write fails | "Action decided but not confirmed — partial write." | Re-verify / Replay / Export | Yes — append-only; manual reconciliation |

### 16.4 Acceptance criteria (§16)

1. Every failure class renders its status as **visible text** — never a dead-end screen or color-only indicator.
2. Chain-verify broken (`ok: false`) **blocks approvals** — all approval buttons are disabled when `chain.verify().ok === false`.
3. The 402/429 fallback message is visible and includes "falling back" — verifiable by DOM textContent.
4. Playground timeout shows `timedOut: true` in the audit event and a timeout message — verifiable by `playground_run` event inspection.
5. Adapter probe `blocked` (SSRF) is never auto-retried — the `result: 'blocked'` state persists until human action.
6. SSE disconnect shows `.dot.off` and a resync banner — verifiable by class attribute inspection.
7. Partial write failure shows a distinct message from a full failure — verifiable by textContent.
8. Approvals are disabled during gateway unreachability — verifiable by button `disabled` attribute.
9. The LLM fallback chain includes `{fallback: true, reply, error}` — verifiable by `chat()` return value inspection.
10. No failure class silently retries a non-idempotent operation — verifiable by confirming no automatic retry after a failure event.

---

## §17 Motion / live states — motion as state telemetry, not decoration

### 17.1 Design principle

Motion on the Trust Gateway console is **state telemetry** — it communicates that something is alive, requires attention, or has transitioned. It is never decoration. Three live-object categories define the motion vocabulary:

- **Requires-your-attention** (pulses): new approval request, chain tamper detected, auth rejection. These pulse or use assertive animation to break through the operator's scan.
- **Running** (subtle): SSE stream feed, chat bubble typing indicator, countdown timer. These use minimal, continuous motion that doesn't demand attention.
- **Stable** (no motion): verified chain, completed approval, settled action. These surfaces are static. No motion on a settled object.

### 17.2 Live object presence

| Surface | Live? | Motion signal | Source |
|---|---|---|---|
| SSE feed stream | Yes | `.row` flash animation (1.2s ease-out) — new rows pulse briefly | `app/style.css` `@keyframes flash` |
| Approval queue | Yes | `.card` appears with `.countdown` ticking; new cards pulse | `app/app.js` `refreshPending` |
| Chain pill | Yes | `.dot.on` glow (box-shadow pulse) when live | `app/app.js` `setPill` |
| Chat bubble (typing) | Yes | Shows `…` while awaiting response | `app/app.js` `chat()` |
| Provider status | No (polling) | Static; updates on poll, no animation | `providers-live.js` `probeAll` |
| Countdown timer | Yes | Text updates every 1s; no animation on the card itself | `app/app.js` `tick()` |
| Approve/deny buttons | No (idle) | Hover only; no motion on state change | `app/style.css` `.btn` |

### 17.3 SSE-driven transitions

| Event | Transition | Duration | Easing |
|---|---|---|---|
| New audit row (stream) | Slide-in from left + flash | 1200ms | `ease-out` (`@keyframes flash { from { background: #1c2a3a } to { background: transparent } }`) |
| New approval card | Fade-in + appear | 300ms | `ease-out` |
| Approval resolution | `.card.done` opacity transition | 200ms | `ease-in` |
| Chain pill state change | Instant (no transition) | 0ms | — |
| Chat bubble response | Replace `…` with text | Instant | — |
| SSE disconnect | `.dot.on` → `.dot.off` | Instant | — |

**New turn slide vs. re-render:** A new turn in the chat stream appends a `.row` element (slide-in). A re-render (e.g., chain verify update) replaces the `.pill` textContent instantly (no transition). The distinction: stream events **append**; state changes **replace**. Appends animate; replacements are instant.

### 17.4 Timing table

| Token | Value | Usage |
|---|---|---|
| `--tg-motion-instant` | `0ms` | State replacements, disconnect, resolution |
| `--tg-motion-fast` | `200ms` | Card opacity, hover transitions |
| `--tg-motion-normal` | `300ms` | Approval card fade-in |
| `--tg-motion-slow` | `1200ms` | Stream row flash (the only long animation) |
| `--tg-easing-standard` | `ease-out` | Enter animations |
| `--tg-easing-exit` | `ease-in` | Exit/removal animations |
| `--tg-easing-decelerate` | `ease` | Status transitions (instant) |
| `--tg-countdown-interval` | `1000ms` | `setInterval` for approval countdown |
| `--tg-ssel-keepalive` | `25000ms` | SSE heartbeat (`events.js` `HEARTBEAT_MS`) |
| `--tg-ssel-retry` | `3000ms` | SSE reconnect (`events.js` `retry: 3000`) |

### 17.5 Reduced-motion equivalents for every animation

| Animation | Normal | Reduced-motion equivalent |
|---|---|---|
| `.row` flash (1.2s ease-out) | `animation: flash 1.2s ease-out` | `animation: none` — row appears instantly with no background flash |
| New approval card fade-in (300ms) | `opacity: 0 → 1` over 300ms | `opacity: 1` — instant appearance |
| `.card.done` opacity (200ms) | `opacity: 1 → 0.55` over 200ms | `opacity: 0.55` — instant |
| `.dot.on` glow (box-shadow pulse) | Continuous `box-shadow` | Static `box-shadow` — no pulse |
| Countdown tick | `setInterval` 1s | Unchanged — text update, not motion |
| SSE new-turn slide | Slide-in transform | Instant opacity: 1, no transform |
| All `--tg-motion-*` durations | As above | All collapse to `--tg-motion-instant` (0ms) |

**Global rule:** `@media (prefers-reduced-motion: reduce)` sets `--tg-motion-fast: 0ms`, `--tg-motion-normal: 0ms`, `--tg-motion-slow: 0ms`, and overrides every `animation` to `none`. The `responsive.css` `.row { animation: none }` is the seed; the global block extends it universally.

### 17.6 Heartbeat affordance — "is it still alive?"

Every live surface must answer "is it still alive?" without the operator needing to check. The heartbeat is a **visible, time-bounded affordance** — not a hidden timer.

| Surface | Heartbeat | Staleness threshold | Stale state |
|---|---|---|---|
| SSE feed | `.dot.on` (green glow) | `es.onerror` → `.dot.off` (red) | "Gateway unreachable — SSE connection broken" banner |
| Approval countdown | `.countdown` text ("expires in 42s") | `expiresAt - Date.now() ≤ 0` → "expired" | Card shows "expired" text; approval fails closed (see `approvals.js` `_expired`) |
| Chain verify | `.pill` text + `.dot` | `setPill(v.ok)` on verify; no periodic re-verify | If SSE drops, the last known state persists until next verify |
| Provider status | `probeAll` result | Last probe timestamp > `PROBE_TIMEOUT_MS * 2` (10s) | Show `--tg-state-unknown` ("last probed Ns ago") |
| Chat bubble | `…` → reply | No response within `TG_LLM_TIMEOUT_MS` (default 20s) | "The model is unavailable right now — falling back." |

**Staleness thresholds (cited from code):**
- SSE: `events.js` `HEARTBEAT_MS = 25_000` — a keepalive is pushed every 25s. If no frame + no keepalive for `2 × HEARTBEAT_MS = 50s`, the connection is stale. `retry: 3000` in the SSE response tells the browser to reconnect after 3s.
- Approval TTL: `approvals.js` `DEFAULT_TTL_MS = 15 * 60 * 1000` (15 min). `_expired(req)` returns `true` when `now > expiresAt`. The countdown renders the remaining time.
- Playground timeout: `playground.js` `DEFAULT_TIMEOUT_MS = 3000` (3s). `SIGKILL` after timeout.
- LLM timeout: `llm-brain.js` `DEFAULT_TIMEOUT_MS = 20_000` (20s).

### 17.7 Never animate to hide latency

**MUST NOT:** Use a spinner or animation to obscure the fact that the gateway is slow. If an action takes >100ms, show the latency honestly — not a decorative spinner.

**Rules:**
- **Spinners only with a time estimate or none.** If a spinner is used, it must include a time estimate ("processing… ~3s remaining") or be bounded by a known timeout (playground 3s, LLM 20s). An unbounded spinner is forbidden.
- **The chat bubble `…` is a placeholder, not a spinner.** It communicates "waiting for a reply" — the reply text replaces it. No rotation animation.
- **The countdown timer is text, not a spinner.** "expires in 42s" is a text update — no animated ring or bar.
- **The chain pill does not spin.** It shows "SEALED ✓" or "TAMPERED ✖" — static text with a color + glow. No rotation, no pulse beyond the `box-shadow`.

### 17.8 MUST / SHOULD / MAY

| Level | Rule | Source |
|---|---|---|
| **MUST** | `requires-your-attention` objects (new approvals, chain tamper, auth rejection) MUST use assertive motion or instant appearance — never subtle | §17.2 |
| **MUST** | `prefers-reduced-motion: reduce` collapses ALL animations to 0ms / `none` — no exceptions | §17.5 |
| **MUST** | Heartbeat affordance MUST be visible and time-bounded on every live surface | §17.6 |
| **MUST** | Spinners MUST include a time estimate or not be used at all | §17.7 |
| **MUST** | SSE-driven new rows animate (slide + flash); state replacements are instant | §17.3 |
| **SHOULD** | The chain pill glow (`box-shadow`) subtly when live to confirm connectivity | §17.2 |
| **SHOULD** | Approval card fade-in uses 300ms ease-out — noticeable but not distracting | §17.3 |
| **SHOULD** | Provider status staleness shows "last probed Ns ago" after 10s | §17.6 |
| **MAY** | Custom easing tokens beyond `ease-out` / `ease-in` for surface-specific transitions | §17.4 |
| **MAY** | Pulse animation on `.dot.on` (the `box-shadow` glow) — currently static, MAY be animated | §17.2 |

### 17.9 Acceptance criteria (§17)

1. Every `.row` in the stream uses `animation: flash 1.2s ease-out` — verifiable by computed `animation` style.
2. `prefers-reduced-motion: reduce` collapses all animations to `0ms` / `none` — verifiable with the media query forced.
3. New approval cards fade in at 300ms — verifiable by `animation-duration`.
4. `.dot.on` uses `box-shadow: 0 0 6px #58d68d` as the live heartbeat — verifiable by computed style.
5. The chat bubble shows `…` (no rotation) while awaiting — verifiable by `textContent` and absence of `animation`.
6. The countdown timer is text ("expires in 42s"), not an animated bar — verifiable by DOM structure.
7. No unbounded spinner exists in the UI — verifiable by confirming all animated elements have a bounded duration or a time estimate.
8. SSE heartbeat interval is 25s (`HEARTBEAT_MS`) and reconnect retry is 3s (`retry: 3000`) — verifiable by `events.js`.
9. Chain-verify staleness flips `.pill` to `--tg-state-blocked` when `verify().ok === false` — verifiable by class attribute.
10. Approval expiration flips `.card` to "expired" text when `now > expiresAt` — verifiable by `countdown.textContent`.
11. Every live surface has a defined heartbeat affordance and staleness threshold — verifiable by table completeness in §17.6.
12. State replacements (chain pill, approval resolution) are instant (0ms) — verifiable by `transition-duration: 0s`.

---

## Summary

This document defines the complete experience specification for Trust Gateway v2 across five axes: **Design System** (§13), **Accessibility** (§14), **Responsive/Cross-device** (§15), **Failure & Recovery UX** (§16), and **Motion/Live States** (§17). Every token maps to a `--tg-*` CSS custom property ready for implementation. Every failure class is rooted in actual code (`llm-brain.js`, `hash-chain.js`, `adapters.js`, `playground.js`, `server.js`, `events.js`, `app/app.js`). All acceptance criteria are testable against the running console or the audit chain.

**BACKEND GAP list:**
- No CI pipeline exists — all five testing-bar items (axe, keyboard, SR, contrast, reduced-motion) are specification targets without automated validation.
- 429 rate-limit auto-backoff (Class A recovery) is a SHOULD, not yet implemented.
- Stale-state detection on SSE disconnect (§15.5) — gap detection logic (head-hash comparison) is spec-defined but not yet implemented in `app/app.js`.
- Terminal `tg approve` / `tg deny` parity (§15.2) — CLI commands are spec-defined; `bin/tg.js` is owned by W7 CLI/TUI (v2/cli branch).
- Focus trap for modal/command palette (§14.5) — the modal exists in CSS but focus management logic is not yet implemented.
