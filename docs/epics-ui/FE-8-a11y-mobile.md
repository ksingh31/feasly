# FE-8 — Accessibility & mobile hardening pass

**Goal:** the cross-cutting pass that runs after the screens exist. Every screen
re-verified against the bar: keyboard-complete, screen-reader-clean, and genuinely
good on a mid-range phone — not just "doesn't break."

## Stories (build order)

### FE8-001 — Keyboard + screen-reader pass (S0 → S8)
**Size:** M
**Description:** Scripted keyboard-only run of the entire funnel (S0 landing through
S8 report, incl. gate modal and re-issue flow): every control reachable and
operable, focus visible, focus trapped in the modal and restored on close, step
headings announced on advance, blur regions expose the "Available after email
verification" text alternative, form errors announced via `aria-describedby` /
`role="alert"`. `axe-core` on every route: zero critical/serious (CI gate from
FE0-006 runs it; this story fixes what it finds).
**Acceptance criteria:**
- Playwright keyboard-only script completes S0→S8 with zero mouse input.
- axe: zero critical/serious violations on all routes (CI-enforced).
- Screen-reader spot-check notes (NVDA/VoiceOver) recorded in the story PR.
**Tests:** the scripted run *is* the test; axe in CI.
**Mobile:** TalkBack/VoiceOver spot-check on the gate + report at 390px.
**Config notes:** n/a.
**Dependencies:** FE-1…FE-5 complete.

### FE8-002 — Mobile responsive + touch pass (all screens)
**Size:** M
**Description:** Every screen at 390×844 (and 360×740): no horizontal scroll, no
overlapping sticky CTAs, touch targets ≥44px, inputs ≥16px font (no iOS zoom),
autocomplete and dropdowns usable with the software keyboard open, blur effect
performant on a Moto G-class profile (no layout thrash — `will-change` scoped),
print stylesheet sane from the mobile layout. Fixes land as `fix(fe8):` PRs
against the owning story's area, each re-running that story's mobile test.
**Acceptance criteria:**
- Visual-regression baseline per screen at 390×844 committed; PR diffs reviewed.
- Sticky CTA never overlaps the focused input (scripted: focus each input, screenshot).
- Moto G emulation: no dropped frames on the S4→S5 transition (Perf trace assertion).
**Tests:** visual regression + scripted focus/overlap checks.
**Mobile:** this story *is* the mobile test.
**Config notes:** n/a.
**Dependencies:** FE-1…FE-5 complete.

### FE8-003 — Reduced motion + performance budget pass
**Size:** S
**Description:** `prefers-reduced-motion`: all transitions/fades/shimmers become
instant (S4 beat, S5 fade, tier-toggle shimmer). Performance: JS initial ≤200KB
gzipped, per-page image weight ≤500KB, LCP ≤2.5s / INP ≤200ms / CLS ≤0.1 on the
Lighthouse gate (FE0-006). Any PR growing JS >5KB gzipped notes the tradeoff in
its description (bot comment). Font loading: `font-display: swap`, no invisible-text
flashes on slow 4G.
**Acceptance criteria:**
- Reduced-motion emulation: zero animated transitions observed (scripted).
- Lighthouse budgets hold on `/`, `/communities/`, 3 sampled community pages.
- Slow-4G trace: hero text visible <2s (no blank page waiting on fonts/JS).
**Tests:** scripted motion + perf assertions; Lighthouse CI.
**Mobile:** slow-4G + Moto G is the reference profile.
**Config notes:** budget numbers in `budgets.json` (config, not code).
**Dependencies:** FE-1…FE-6 complete.
