# FE-10 — "Free" CTA + consistent back navigation

**Goal (Karan, 2026-09-27):** the unlock CTA must say **free** so users trust the
gate, and back controls must sit in one consistent, visible spot on every wizard
step. One shared top-of-step back pattern; no per-page drift.

## Stories (build order)

### FE10-001 — "Free" in every unlock CTA
**Size:** S
**Description:** Add the word **free** to each unlock CTA in the wizard/embed
funnel (copy-owned, `app-config.defaults.ts`):
- Gate submit (`copy.gate.submitLabel`): 'Unlock My Preview →' →
  'Unlock my free preview →'
- Preview page + report page pre-gate CTA (`copy.report.unlockCta`):
  'Unlock my full report →' → 'Unlock my free report →'
- Compare results unlock (`copy.compare.unlockCta`): 'Unlock Full Numbers →' →
  'Unlock my free numbers →'
- Report pre-gate sub (`copy.report.subPreGate`): 'Your preview is ready — unlock
  it to see the full numbers.' → 'Your free preview is ready — unlock it to see
  the full numbers.'
"Unlock" stays reserved for the preview→gate direction (standing product rule).
Embed flows reuse the same wizard components, so they inherit the copy.
**Acceptance criteria:**
- Gate submit button, preview-page unlock CTA, report-page pre-gate unlock CTA,
  and compare-results unlock CTA all contain the word "free".
- Copy comes from config; no hardcoded CTA strings in templates.
- Existing specs asserting old copy updated.
**Tests:** spec — copy values; UI — CTA rendering on gate + preview pages.
**Config notes:** `app-config.defaults.ts` only; `app-config.ts` types unchanged
(no new keys, only value edits).

### FE10-002 — shared wizard back-bar component
**Size:** M
**Description:** New shared component `WizardBackComponent`
(`apps/web/src/app/shared/components/wizard-back/`): a consistent top-of-step
back bar rendered as the first element inside `<main>` on every wizard step —
scope, details, preview, reno-scope, reno-coming-soon, gate, analyzing.
Inputs: `label` (required, config-owned per page), `link` (required routerLink
target), `step` (optional — dispatches `GoToStep(step)` before navigation, same
as today's per-page `goBack()` handlers). Removes each page's bespoke
`.back` link/button and its `goBack()` handler (behavior preserved via inputs).
Styling: stronger visual weight than today's plain text link — pill/chip with
border, ← glyph, hover/focus states, ≥44px touch target, consistent left
alignment at the top of every step (the preview page's top placement becomes
the pattern everywhere).
**Acceptance criteria:**
- Every wizard step shows the back control in the same position (top, above the
  heading) with identical styling.
- Back still dispatches the same `GoToStep` and navigates to the same target as
  before on every step (spec coverage per step's target).
- No orphaned `.back` styles or `goBack()` handlers left on wizard pages.
- Keyboard-focusable, visible focus ring, `aria-label` on the control.
**Tests:** spec — component renders label/link, dispatches GoToStep when `step`
given, skips dispatch when absent; per-page specs updated for the new markup.
**Mobile:** ≥44px target; full-width-safe at 375px.

## Dependencies
- PR #252 (lot-coverage early guard) touches wizard files: if unmerged while
  this lands, rebase onto it and resolve conflicts in the wizard templates.

## Merge gate
Full local verification before push (web suite, app+spec `--noEmit` typechecks,
lint, production build) + browser QA in Chrome and Safari/WebKit, desktop and
mobile (gate CTA copy, back-bar position/visibility on each step).
