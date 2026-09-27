# FE-9 — Admin leads redesign (approved premium mockup)

**Goal:** rebuild the admin leads UI (`apps/web/src/app/features/admin`) to match
the approved premium redesign mockup (artifact slug: `admin-leads-redesign-mockup`).
Cream/charcoal/brass palette, buyer-grade typography (Manrope headings, Instrument
Sans body — see Karan's typography lock), centered lead-detail modal replacing the
current side drawer, and a prominent Pipeline card. Design-only mockup decisions
were approved by Karan 2026-09-27; this epic implements them for real.

**Non-goals:** assign-to-builder backend (no endpoint exists — UI only, clearly
marked PLACEHOLDER, see FE9-002); builder dispute UI (deferred by Karan, empty
disputes queue is expected).

## Stories (build order)

### FE9-001 — Leads list redesign
**Size:** M
**Description:** Rebuild the leads list to the mockup: cream background, charcoal
text, brass accents; lead rows with avatar initials, name, email/phone, property
summary, estimate range, status badge, consent indicators. Three streamlined
filters replace the current ten (search text, status, assigned — match the
mockup's three exactly). Pipeline totals row above the list (counts per status).
**Acceptance criteria:**
- List renders all current columns' data with no loss (every field visible today
  is visible in the redesign).
- Exactly three filters; each filters the list; clearing restores full list.
- Pipeline totals match the filtered/unfiltered counts.
- Empty state has designed copy.
**Tests:** component specs — filtering, totals, empty state, row click opens modal.
**Mobile:** list stacks to cards at 390×844; filters collapse into a disclosure.
**Dependencies:** none.

### FE9-002 — Centered lead-detail modal
**Size:** M
**Description:** Replace the side drawer with a centered modal (max-width ~720px,
overlay scrim, Esc/backdrop close, focus trap). Sections per mockup: header
(avatar, name, email · phone, close), **Pipeline** card, Contact grid (email,
phone, source, tenant, magic link, contact consent, marketing consent), Property
& estimate, Activity timeline (status history), Notes.
**Acceptance criteria:**
- Opens centered on desktop; near-full-screen sheet on mobile.
- All sections from the current drawer are present (no data loss).
- Consent badges show real values (In/Out, Yes/No) with accessible labels.
**Tests:** spec — open/close, focus trap, Esc; no data-loss assertion per section.
**Mobile:** sheet slides up, scrolls internally, close always visible.
**Dependencies:** FE9-001.

### FE9-003 — Status change: dropdown + Apply Status
**Size:** S
**Description:** Karan's explicit requirement: NO one-tap segmented status pills
(accidental taps change status). Pipeline card shows a styled dropdown preselected
to the lead's current status, plus an **Apply Status** button that stays **disabled
until a different status is selected**. On apply: call the existing
`AdminLeadsApiService.updateStatus()` (PATCH status → writes lead_status_history +
audit row), optimistically update the modal badge, the list row, pipeline totals,
and status history; on error roll back and show a toast. Cancel/reselect reverts
the dropdown to current status.
**Acceptance criteria:**
- Button disabled when selection == current status; enabled otherwise.
- Successful apply updates badge + row + totals + history without reload.
- Failed apply rolls back the dropdown and surfaces an error (no silent no-op).
- No API exists for assign-to-builder: the Assign-to-builder dropdown renders
  "Unassigned" as a **visual-only PLACEHOLDER** (code comment + `PLACEHOLDER`
  marker), wired to nothing. Do not invent an endpoint.
**Tests:** spec — disabled/enabled states, success path updates all four surfaces,
error rollback; API service spec already covers updateStatus.
**Dependencies:** FE9-002.

### FE9-004 — Browser QA + merge gate
**Size:** S
**Description:** Full local verification per the repo merge gate, then browser QA.
**Acceptance criteria:**
- `npx ng test` full web suite green; typecheck
  (`npx tsc -p apps/web/tsconfig.app.json --noEmit` and `tsconfig.spec.json` —
  NEVER bare `npx tsc -b` on apps/web, it emits .js files); `npm run lint`;
  production build passes.
- Browser QA: Chrome desktop + mobile emulation (390×844), Safari/WebKit desktop
  + mobile: list renders, filters work, modal opens/closes, status
  dropdown + Apply flow works, no console errors.
- Admin-authenticated flows (real admin session) need Karan's sign-in approval —
  do NOT use his credentials; test everything reachable without them and flag
  the rest for his approval.
- PR opened, CI green, **do not merge** (manager merges).
**Tests:** n/a (this story is verification).
**Dependencies:** FE9-001…FE9-003.

## Standing rules for this epic
- NGXS for state; `takeUntilDestroyed()` on every subscribe; no orphaned timers.
- Shared UI in `apps/web/src/app/shared/`; DRY — no copy-paste from the old drawer.
- Commit early and often. Branch: `feat/admin-leads-redesign`.
- Do not touch billing/disputes files (PR #254 owns admin-billing).
