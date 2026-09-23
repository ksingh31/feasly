# FE-2 — Estimate wizard (S1–S3)

**Goal:** the three-step wizard that feels effortless and trustworthy — never like a
data grab. Address → scope → details, with state that survives refresh and failure
states that never strand the user.

## Stories (build order)

### FE2-001 — Wizard shell: state service, step indicator, routing
**Size:** M
**Description:** `WizardStateService` (signals) holding `{ address_key, property,
sqft, tier, garage, basement, step }`; persists to `localStorage` (`feasly.wizard.v1`)
on every change; refresh restores and lands on the current step. Step indicator
("Step X of 3"), back navigation, focus moves to the step heading on every advance.
Routes: `/estimate/address`, `/estimate/scope`, `/estimate/details` (only address
prerenders as the deep-link entry; scope/details are CSR + `noindex`).
**Acceptance criteria:**
- Refresh mid-wizard restores inputs and step; stored payload contains zero
  `email`/`name`/`phone` keys pre-gate (assertion).
- Focus lands on the step heading on advance (scripted keyboard test).
- Direct URL entry to `/estimate/details` with empty state redirects to S1 (no broken state).
**Tests:** spec — persistence, restore, key allowlist; UI — indicator renders.
**Mobile:** indicator compact at 390px; back button ≥44px.
**Config notes:** storage key + version from config (bump version = clean migration).
**Dependencies:** FE0-001…FE0-003.

### FE2-002 — S1 address step + property card + failure states
**Size:** M
**Description:** Address field + autocomplete (shared component with S0), property
card on select (community, lot size, zoning, assessed value, year built + the
data-freshness line "City-assessed value, {year} — data as of {date}" and a
"may be outdated" chip when `stale`). "Continue →" disabled until selection.
All four failure states with exact UX copy: not found, non-Calgary, City-data-down
(+ working Retry), multi-unit. Mock contract: `PropertyRecord` + error envelope.
**Acceptance criteria:**
- Card shows all five fields; assessed value formatted `$729,000` (no cents).
- Each error code renders its exact copy; Retry re-fires the mock lookup.
- Continue uses `aria-disabled` until selection; Enter on a suggestion selects it.
**Tests:** spec — error-code → copy mapping, retry; UI — card layout.
**Mobile:** card stacks cleanly; autocomplete dropdown doesn't clip under the keyboard;
Retry button thumb-reachable.
**Config notes:** all four error strings from config (single source for API parity later).
**Dependencies:** FE2-001.

### FE2-003 — S2 scope step: New Build vs Renovation
**Size:** S
**Description:** Two cards — "New Build" (selectable) and "Renovation" (visible,
disabled, "Coming soon" badge). CTA "See My Preview →", back "← Address". The
disabled state is a config flag (`features.renovationEnabled`) so a future phase
flips it without code changes.
**Acceptance criteria:**
- Renovation card: `aria-disabled="true"`, reduced opacity, badge; click/keyboard
  does nothing (no dead-end navigation, no focus trap).
- Selecting New Build enables CTA → `/estimate/details`.
- Flag flip enables the card (spec test) — future-proofing, not a promise.
**Tests:** spec — disabled behavior, flag flip; UI — card visuals.
**Mobile:** cards stack vertically; both ≥44px tall targets.
**Config notes:** badge copy + flag from config.
**Dependencies:** FE2-001.

### FE2-004 — S3 details step: 4 inputs, zero friction
**Size:** M
**Description:** Living-area sqft (slider + numeric input synced, default 2,400,
range 800–6,000, out-of-range clamps with an inline note — never silently),
finish tier segmented (Standard/Premium/Luxury), garage segmented
(None/Double/Triple), basement toggle (Unfinished/Finished). CTA "See My Preview →".
Every change persists via `WizardStateService`. "Edit my details" (from S5) returns
here with state intact.
**Acceptance criteria:**
- Slider ↔ numeric stay in sync; clamp note appears on out-of-range entry.
- Refresh restores all four inputs.
- No `$/sqft` or "per sq ft" anywhere in templates (copy-lint).
**Tests:** spec — sync, clamp, persistence; UI — control layout.
**Mobile:** slider thumb ≥44px touch area; numeric input `inputmode="numeric"`,
font-size ≥16px (no iOS zoom); segmented controls wrap without overflow.
**Config notes:** defaults, min/max, tier labels from config.
**Dependencies:** FE2-001.
