# EPIC 03 — Consumer Web

**Owner:** TPM (implementation epics)
**App:** `apps/web` (Angular 17+ standalone components + signals)
**Milestone coverage:** M1 (S0–S8, S11, S12/S13), plus S9/S10 callback & partner-share flows

## Goal

Ship the complete consumer funnel per UX_FLOW.md: S0 landing → 3-step wizard
(S1 address, S2 scope, S3 details) → S4 dark analyzing beat (every line backed
by a real API call) → S5 blurred preview with the single "Unlock Full Numbers →"
CTA → S6 lead gate (magic link) → S7 check-email → S8 full report with tier
what-if toggle, inline re-run, next-3-steps, partner share, PDF, and callback
via Postmark email → S9/S10/S11/S12/S13. Build-time prerendered on Azure Static
Web Apps (never pure CSR), theme tokens from the prototypes, privacy-friendly
analytics, full a11y, mobile-first.

## Non-goals

- Admin dashboard (M4 epic).
- Renovation selectable flow (M2 epic; this epic renders the disabled card only).
- Neighbourhood comparison UI (M3 epic).
- Waitlist capture for non-Calgary addresses (deferred per UX_FLOW — the
  non-Calgary state shows the message; no email capture form in M1).
- Google Sheets sync UI (M4).
- API/MCP surfaces (M5 epic).

## Key decisions

1. **Prerendering:** Angular `application` builder with `prerender` — routes
   `/`, `/estimate/address`, `/estimate/scope`, `/estimate/details`,
   `/preview`, `/privacy`, `/terms`, `/check-email` prerendered at build.
   `/r/{token}` is **never** prerendered (dynamic, PII) — served CSR with
   `noindex`. `isPlatformBrowser` guards around `localStorage`/`window` everywhere.
2. **PDF: print-stylesheet, not server-side.** Justification: the report page
   already renders every figure client-side post-gate; a dedicated `@media print`
   stylesheet + `window.print()` gives a branded PDF with zero new infra, zero
   per-download cost, and no server-side HTML→PDF dependency to maintain.
   Server-side PDF is the fallback if Karan later wants emailed PDFs or
   pixel-identical output. (Decision logged; revisit trigger: emailed-PDF requirement.)
3. **State:** wizard state in a `WizardStateService` (signals) persisted to
   `localStorage` key `feasly.wizard.v1` on every change; nothing sensitive
   pre-gate (address, sqft, tier, garage, basement only — no email/name until S6).
4. **Blur implementation:** CSS `filter: blur(12px)` + `aria-hidden="true"` on
   the figure + a visually-adjacent text alternative `"Available after email
   verification"` for screen readers; blurred values are **never in the DOM as
   plaintext** — the API returns `{ blurred: true }` placeholders pre-gate and
   real numbers post-gate, so view-source can't leak them.
5. **"Unlock" appears exactly once** in the UI copy: S5 primary CTA
   `"Unlock Full Numbers →"`. A copy-lint test greps `apps/web/src` for
   `/\bunlock\b/i` and fails on any second occurrence.
6. **Analyzing beat honesty:** each S4 step label maps 1:1 to an awaited
   promise (property lookup → estimate POST → narrative readiness check →
   preview render); steps advance only when the promise resolves. No timers
   faking work.
7. **Callback = email, not Calendly:** S9 POSTs to `/api/v1/reports/{token}/callback-requests`;
   the Functions app sends a Postmark email to the Feasly team inbox
   (`NEEDS-KARAN`: the destination inbox address).

---

## Stories (dependency order)

### WEB-001 — Angular scaffold: prerendering, theme, shell
**Description:** Scaffold `apps/web` with Angular 17+ (`application` builder,
standalone components, signals, zoneless where practical), `app.routes.ts`
with all M1 routes, prerender config for public routes only, and the design
system from prototypes as CSS custom properties + Tailwind-equivalent tokens:
`--canvas: #1C1914`, `--cream: #F7F4EF`, `--brass: #A8761A`, Syne (display) +
Instrument Sans (body) via Google Fonts with `font-display: swap`. App shell:
header (wordmark + "How it works" anchor), footer (Privacy · Terms links),
`<main>` landmark, global focus-visible styles, `prefers-reduced-motion` media
query disabling transitions.

**Acceptance criteria:**
- `ng build` emits prerendered `index.html` for `/`, `/estimate/address`,
  `/privacy`, `/terms` with full hero copy in the HTML (curl the dist file and
  grep — no JS required to read it).
- `/r/{token}` is NOT in the prerender manifest (assert via build output listing).
- Lighthouse on prerendered `/`: Performance ≥ 90, Accessibility ≥ 95 (budgets
  tightened in EPIC 04's CI gate; this story establishes the baseline).
- Theme tokens render: canvas hero, cream body, brass primary CTAs; Syne on
  `h1`, Instrument Sans on body (visual check + computed-style test).

**Dependencies:** M0 repo scaffold.
**Size:** M

### WEB-002 — Property lookup service (City data via API)
**Description:** Build `PropertyService` (`apps/web/src/app/core/services/property.service.ts`)
calling `GET /api/v1/property?address=...` (Functions app wraps the Socrata
`4bsw-nn7w` dataset; client never touches Socrata directly). Types:
`PropertyRecord { address, community, lot_sqft, zoning, assessed_value,
year_built, address_key }`. Address autocomplete: `GET /api/v1/properties/autocomplete?q=...`
(3+ chars, 250ms debounce, max 6 suggestions, keyboard navigable per
`ComboboxComponent`), each suggestion guaranteed resolvable. Map API error
codes to the four UX_FLOW failure states: `not_found`, `non_calgary`,
`service_down`, `multi_unit`.

**Acceptance criteria:**
- Typing 3+ chars fires a debounced search; selecting a suggestion resolves to
  a full `PropertyRecord` (integration test against the Functions API with a
  stubbed Socrata response).
- Each of the four error codes renders its exact UX_FLOW copy (unit tests on
  the error mapper).
- Autocomplete is keyboard navigable (arrow keys + Enter + Escape) with
  `role="combobox"` / `aria-expanded` / `aria-activedescendant` (a11y test).
- No Socrata URL or dataset ID appears in the client bundle (grep dist for
  `socrata` / `4bsw-nn7w` → zero hits).

**Dependencies:** WEB-001; Functions `GET /api/v1/property*` endpoints (API-layer work — this story defines the contract it consumes).
**Size:** M

### WEB-003 — S0 landing (`/`)
**Description:** Hero "What will it really cost to build your home in Calgary?",
address input with autocomplete (on select → route to S2 with property
pre-loaded, skipping S1), trust strip with NO ± figure
("Range-based estimates · Real City of Calgary data · AI cost breakdown"),
"How it works" 3-step section, sample report link **(NEEDS-KARAN Q4 confirm)**,
footer with Privacy/Terms, mobile single column with sticky CTA.

**Acceptance criteria:**
- Address select navigates to `/estimate/scope` with `WizardStateService.property`
  populated; wizard step indicator shows step 2 of 3.
- Trust strip contains no `±`, `%`, or accuracy claim (copy-lint test).
- Sample report link present only if Karan confirms Q4; if declined, the slot
  is removed (not a dead link) — implement behind `features.sampleReport` flag.
- Sticky mobile CTA visible without scrolling on 390px viewport (visual test).

**Dependencies:** WEB-001, WEB-002
**Size:** S
**NEEDS-KARAN:** Q4 — sample report on landing? (Recommendation: yes, fictional address labeled "Sample".)

### WEB-004 — S1 address step (`/estimate/address`)
**Description:** Wizard step 1: address field + autocomplete dropdown, property
card on select (community, lot size, zoning, assessed value, year built),
"Continue →" CTA (disabled until a property is selected), "← Back" to landing.
All four failure states from UX_FLOW with Retry where specified. Focus moves
to the step heading on entry.

**Acceptance criteria:**
- Property card shows all five fields; assessed value formatted `$729,000`
  (no cents); zoning shown as the City's land-use designation verbatim.
  **Data-freshness line under the assessed value** (USER_VALIDATION.md gap 8):
  "City-assessed value, {assessment_year} — data as of {fetched_at, date}"
  (from `GET /api/v1/properties/resolve`); if `stale: true`, a "may be
  outdated" chip appears (no alarmist copy, no blocking).
- Each failure state renders its exact UX_FLOW copy; `service_down` shows a
  working Retry button that re-fires the lookup.
- Refresh mid-step restores the selected property from `localStorage`
  (nothing sensitive stored — assert no email/name keys present).
- Continue is disabled with `aria-disabled` until selection; Enter on a
  suggestion selects it.

**Dependencies:** WEB-002
**Size:** S

### WEB-005 — S2 scope step (`/estimate/scope`)
**Description:** Wizard step 2: two cards — "New Build" (active, selectable) and
"Renovation" (visible, disabled, badge "Coming soon"). CTA "See My Preview →",
back "← Address". **(NEEDS-KARAN Q1 confirm:** disabled+badged vs selectable→waitlist;
recommendation: disabled + badge.)

**Acceptance criteria:**
- Renovation card is visibly disabled (`aria-disabled="true"`, reduced opacity,
  badge "Coming soon"); clicking/keyboard-activating it does nothing (no dead-end
  navigation, no focus trap).
- Selecting New Build enables the CTA; CTA routes to `/estimate/details`.
- If Karan picks the waitlist option (Q1), this story is re-scoped — decision
  recorded before build starts (assumption: disabled + badge).

**Dependencies:** WEB-004
**Size:** S
**NEEDS-KARAN:** Q1 — renovation card: disabled + "Coming soon" badge (recommended) vs waitlist capture.

### WEB-006 — S3 details step (`/estimate/details`) + wizard persistence
**Description:** Wizard step 3, max 4 inputs: living-area sqft (slider +
numeric input, default 2,400, range 800–6,000), finish tier segmented control
(Standard/Premium/Luxury, default Standard), garage segmented (None/Double/Triple),
basement toggle (Unfinished/Finished). CTA "See My Preview →", back
"← Project type". `WizardStateService` persists every change to
`localStorage` (`feasly.wizard.v1`); refresh restores and lands on the current
step; "Edit my details" from S5 returns here with state intact.

**Acceptance criteria:**
- Slider and numeric input stay in sync; out-of-range numeric entry clamps
  with an inline note (not a silent clamp).
- Every change writes `localStorage`; refresh on S3 restores sqft/tier/garage/basement.
- Stored payload contains only `{ address_key, sqft, tier, garage, basement, step }`
  — test asserts no `email`/`name`/`phone` keys pre-gate.
- No $/sqft figures anywhere in the UI (copy-lint: no `$/sqft`, `per sq ft` in templates).

**Dependencies:** WEB-005
**Size:** M

### WEB-007 — S4 analyzing beat (`/analyzing`)
**Description:** Dark full-screen beat (`--canvas` background) with 4 steps:
"Looking up property record…", "Pulling lot & zoning details…",
"Calculating build cost…", "Generating your preview…". Each line maps to a
real awaited call: (1) `PropertyService` resolve (or cached), (2) lot/zoning
enrichment from the property record, (3) `POST /api/v1/estimates` (new_build),
(4) preview render readiness. Auto-advances to `/preview` on success with a
fade transition; respects `prefers-reduced-motion` (instant, no animation).
Failure at any step → falls back to an S1-style error panel with Retry
(never strands on the dark screen); refresh on `/analyzing` resumes at S3.

**Acceptance criteria:**
- Steps light up only as their underlying promise resolves (test with
  deferred promises — step 3 must not show complete before the estimate POST resolves).
- No fake delays: total time on screen equals real backend latency (assert no
  `setTimeout` > 300ms in the component — lint rule).
- Backend failure renders "City property data is temporarily unavailable…"
  style error + working Retry; screen never stays dark-and-stuck.
- Refresh on `/analyzing` lands on `/estimate/details` with state intact.

**Dependencies:** WEB-006; ENG-009 (`POST /api/v1/estimates`)
**Size:** M

### WEB-008 — S5 preview (`/preview`): blur + the single Unlock
**Description:** Shows VISIBLE fields (address, community, lot size, zoning,
assessed value, sqft, tier) and BLURRED build/total ranges (blur + lock icon,
`aria-hidden` with text alternative "Available after email verification").
Copy: "Your numbers are ready." Primary CTA "Unlock Full Numbers →" (the only
"Unlock" in the product — copy-lint enforced), secondary "← Edit my details"
(→ S3, state intact). No other forward path. Blurred figures arrive from the
API as `{ blurred: true }` placeholders — real numbers are never in the DOM,
view-source, or the prerendered HTML.

**Acceptance criteria:**
- View-source / DOM inspection pre-gate shows no numeric build/total figures
  (test: `document.body.innerHTML` contains no `$` followed by digits in the
  blurred regions; API stub returns placeholders).
- "Unlock" (case-insensitive) appears exactly once in `apps/web/src` (lint test).
- "Edit my details" returns to S3 with all inputs intact; re-running preview
  reuses the cached estimate (no duplicate `estimates` row — assert single
  `estimate_id` in state).
- Lock icon + blur degrade gracefully if CSS filters unsupported (fallback:
  solid overlay).

**Dependencies:** WEB-007
**Size:** M

### WEB-009 — S6 lead gate (modal)
**Description:** Modal (focus-trapped, Escape closes back to S5): headline
"Where should we send your full report?"; Email (required, validated inline),
Name — "What should we call you?" (required — **NEEDS-KARAN Q2 confirm**),
Phone optional ("Only if you'd like a callback."); **one timeline question**
(decided USER_VALIDATION.md P0-J — feeds hot/warm/cold scoring already in
the schema: "When are you hoping to build?" — chips mapping to the CAP-002
enum `0-3mo / 3-6mo / 6-12mo / 12+mo / exploring`; required, one tap). CASL checkbox unchecked by default
("Email me Calgary market updates & building tips."); microcopy "We'll
email your full report. No spam, unsubscribe anytime." + Privacy/Terms links.
On an **embed tenant**: the gate adds one consent line — "Your details go to
{builder_name}, who may contact you about this estimate." (P1-7; the builder
name comes from `GET /api/v1/embed/config`). CTA "Send My Full Report →".
On submit: `POST /api/v1/leads` (creates user, lead with timeline→hot/warm/
cold scoring server-side, consent timestamp), then magic-link email via
Postmark; → S7. Send failure: "We couldn't send the email — check the
address and try again." + Retry.

**Acceptance criteria:**
- Timeline chips: exactly one question, default unselected; required before
  CTA enables (test: no timeline → CTA disabled, no error nag).
- Invalid email shows inline error on blur/submit; valid submit disables the
  CTA while in flight (no double-submit → no duplicate leads; test double-click).
- On embeds: consent line names the builder (assert `{builder_name}` rendered
  from config; no consent line on the direct feasly.com flow).
- CASL unchecked by default; checking it records `consent_ts` and a
  `marketing_consent: true` flag on the lead (assert in API contract test).
- Lead is persisted even if the user never clicks the magic link (assert
  `POST /api/v1/leads` fires before navigating to S7).
- Modal traps focus, returns focus to the S5 CTA on close; screen-reader
  announces the dialog title.

**Dependencies:** WEB-008; Functions `POST /api/v1/leads` + Postmark magic-link send (API-layer work).
**Size:** M
**NEEDS-KARAN:** Q2 — name field required (recommended) vs optional.

### WEB-010 — S7 check-email (`/check-email`) + resend
**Description:** "We sent a secure link to {email}." Resend link with 60s
cooldown (client-side timer + server rate limit), "Wrong email? Go back"
(→ S6 with fields intact). Note: "This link is valid for 7 days."
**(NEEDS-KARAN Q3 confirm.)**

**Acceptance criteria:**
- Resend button disabled with visible countdown for 60s after send; re-enables after.
- "Wrong email?" returns to S6 with email/name/phone values intact.
- 7-day validity note matches the actual `magic_links.expires_at` policy
  (single source: API returns `expires_in_days`; UI renders it — no hardcoded copy).

**Dependencies:** WEB-009
**Size:** S
**NEEDS-KARAN:** Q3 — 7-day magic-link expiry OK?

### WEB-011 — Magic-link verification + expiry/re-issue (`/r/{token}`)
**Description:** Route `/r/{token}`: on load, `GET /api/v1/magic-links/verify/{token}`
(hash compared server-side, never the raw token in logs). Valid → marks used,
loads the estimate + generates narrative (Meta API, server-side), renders S8.
Invalid/expired → "This link has expired. Enter your email and we'll send a
fresh one." with email input → re-issue flow (`POST /api/v1/magic-links/reissue`).
Route is CSR-only, `noindex`/`nofollow` meta, never prerendered. Bearer-token
semantics documented in the privacy page (link forwarding = access).

**Acceptance criteria:**
- Valid token renders the report; `used_at` set server-side; second use of the
  same token still works within expiry (decided: links are reusable for 7 days —
  simpler than single-use for a "forward to partner" flow; logged).
- Expired token shows the exact re-issue copy; submitting an email triggers a
  fresh link to that email (test the round trip).
- Response headers / meta include `noindex`; route absent from sitemap.xml
  (assert in EPIC 04's sitemap test).
- Raw token never appears in client logs or error reports (lint: no `console.log(token)`).

**Dependencies:** WEB-009; Functions magic-link verify/re-issue endpoints.
**Size:** M

### WEB-012 — S8 full report: figures, narrative, disclaimer
**Description:** Report layout: hero total range, cost rows (Land, Build, Total
+ breakdown rows: site prep, foundation, framing, mechanicals, finishes, soft
costs — from engine `rows[]`), AI narrative summary with the verbatim footer
"Dollar figures are calculated deterministically from our cost model — not
generated by AI.", assessed-value context line, "Prepared {date}" stamp.
"Estimate another address" (→ S1, keeps email). Duplicate estimate
(same email+address) creates a new versioned snapshot; report header shows
"Updated {date}" when >1 snapshot exists.

**Acceptance criteria:**
- All figures match the `estimates.outputs` row for the verified token
  (contract test: UI renders exactly what `GET /api/v1/estimates/{id}` returns).
- Disclaimer footer present verbatim (copy-lint test on the exact string).
- Breakdown rows render only rows the engine returned (no invented line items).
- "Updated {date}" appears when the user has ≥2 snapshots for the address.

**Dependencies:** WEB-011; ENG-010 narrative prompt builder (API uses it server-side)
**Size:** M

### WEB-013 — Tier what-if toggle + inline sqft re-run
**Description:** On S8: tier segmented control (Standard/Premium/Luxury)
re-runs the estimate inline via `POST /api/v1/estimates/{id}/revisions` (same address, new
tier) with a skeleton shimmer on the figures — no wizard restart, no new lead.
Sqft slider + "Re-run" button likewise. Each re-run persists a new immutable
snapshot (audit trail) and updates the narrative only if the tier changed the
numbers materially (narrative regenerates when total range shifts >5%).

**Acceptance criteria:**
- Toggling tier updates all figures without page reload; URL unchanged
  (`/r/{token}` stable — the token identifies the lead, snapshots version underneath).
- Each re-run writes a new `estimates` row (assert row count increments; no UPDATEs).
- Rapid toggling debounces (300ms) and cancels in-flight requests (no race-condition
  figure mix: test with delayed responses asserting last-write-wins).
- Analytics event `tier_toggle` fires (consumed by WEB-017).

**Dependencies:** WEB-012
**Size:** M

### WEB-014 — Next-3-steps, callback (S9), partner share (S10), PDF (S11)
**Description:** "Your next 3 steps" checklist (1. Request a callback, 2. Talk
to your lender about construction financing, 3. Get a lot survey — static
content, checkable, persisted per report in `localStorage`). S9: inline
callback panel — name prefilled, phone required here, preferred time
(Morning/Afternoon/Evening) → "Thanks — we'll call you {window}." →
`POST /api/v1/reports/{token}/callback-requests` → Postmark email to the Feasly team inbox
**(NEEDS-KARAN: destination inbox address)**. S10: partner email input →
"Send" → magic-link report sent to that address → inline "Report sent to
{email}." S11: "Download PDF" → `window.print()` with a dedicated
`@media print` stylesheet (branded: wordmark, figures, assumptions,
disclaimer, "Prepared {date}"; hides nav/CTA chrome).

**Acceptance criteria:**
- Callback submit with missing phone shows inline error; success shows the
  exact "Thanks — we'll call you {window}." copy with the chosen window.
- Team email is sent server-side (assert via API contract test; client never
  sees the destination address).
- Partner share sends a fresh magic link scoped to the same estimate
  (new `magic_links` row, same `estimate_id`).
- Print stylesheet: print preview shows figures + disclaimer, hides header
  nav/CTAs/checklist inputs (visual test via headless Chromium print-to-PDF).
- Checklist state persists per `estimate_id` in `localStorage`.

**Dependencies:** WEB-012; Functions `/api/v1/reports/{token}/callback-requests` + `/api/v1/reports/{token}/shares`.
**Size:** M
**NEEDS-KARAN:** Feasly team inbox address for callback emails.

### WEB-015 — S12/S13 privacy + terms pages
**Description:** `/privacy` and `/terms` prerendered pages, footer-linked
sitewide, covering: what data is collected (address, estimate inputs, email,
consent timestamp), magic-link bearer semantics (forwarding = access),
City-data attribution, no-sold-price / not-an-appraisal disclaimer, CASL
consent wording, contact. **Launch blocker (not dev blocker): lawyer review
before first email is collected.** Ship with clearly-marked draft copy and a
`LEGAL_REVIEW_PENDING` banner in staging only.

**Acceptance criteria:**
- Both routes prerendered, linked in the footer on every page.
- Draft copy includes all six coverage items above (checklist test on headings).
- Staging banner present; production build fails if `LEGAL_REVIEW_PENDING`
  is still true at deploy time (CI check — lawyer sign-off flips the flag).
- No legal claims the narrative is banned from making (cross-check ENG-010
  banned list).

**Dependencies:** WEB-001
**Size:** S
**NEEDS-KARAN:** Lawyer review + sign-off before launch (launch blocker).

### WEB-016 — Accessibility + mobile responsive pass
**Description:** Cross-cutting: focus moves to the step heading on every wizard
advance; blur regions `aria-hidden` with the "Available after email
verification" text alternative; dark S4 respects `prefers-reduced-motion`;
form inputs all labeled; color contrast ≥ 4.5:1 for body text on cream/canvas
(brass `#A8761A` on cream checked — large text only, body uses darkened
`#8A5F14`); touch targets ≥ 44px; autocomplete usable with mobile keyboards;
sticky CTAs don't cover inputs (safe-area padding); blur effect performant on
mid-range Android (no layout thrash — `will-change` scoped, tested on
Moto G-class profile).

**Acceptance criteria:**
- `axe-core` scan on every route: zero critical/serious violations (CI).
- Keyboard-only run S0→S8 completes (scripted Playwright test, no mouse).
- Contrast audit passes for body text; brass-on-cream restricted to ≥18pt/bold.
- 390×844 viewport: no horizontal scroll on any screen; sticky CTA never
  overlaps the active input (visual regression tests).

**Dependencies:** WEB-003 through WEB-014 (pass runs after screens exist)
**Size:** M

### WEB-017 — Privacy-friendly analytics events
**Description:** `AnalyticsService` emitting: `step_view`, `gate_view`,
`gate_convert`, `report_open`, `tier_toggle`, `callback_request`,
`partner_share`, `pdf_download`. No third-party trackers pre-consent; events
POST to `/api/v1/events` (first-party, no cookies, no fingerprinting);
payload = `{ event, route, ts }` only — never email, address, or figures.
Respects a `feasly.analytics_optout` localStorage flag.

**Acceptance criteria:**
- Network log during S0→S8 shows zero requests to third-party analytics
  domains (Playwright request-interception test).
- Event payloads contain no PII (schema test: allowed keys allow-list).
- Opt-out flag stops all emission (test).

**Dependencies:** WEB-001; Functions `POST /api/v1/events` (API-layer work).
**Size:** S

---

### WEB-018 — Consent banner + analytics gating
**Description:** First-party consent banner (decided USER_VALIDATION.md P1-8):
on first visit, a bottom banner explains Feasly's own anonymous usage
analytics with "Essential only" / "OK" buttons; choice persisted in
`feasly.consent` localStorage + server `consent_log`. No analytics events
(including WEB-017's) fire before the user acknowledges. No third-party
trackers at all in M1 (Application Insights = server-side only). The banner
never blocks the wizard (non-modal, dismissible), and the choice is
revisitable from the footer ("Cookie settings").

**Acceptance criteria:**
- Playwright: zero `/api/v1/events` requests before banner acknowledgment;
  events resume after "OK"; still zero after "Essential only".
- Choice persists across reloads (localStorage) and is recorded server-side
  (`consent_log`, asserted in API contract test).
- Footer "Cookie settings" re-opens the banner and can revoke consent
  (events stop; asserted).

**Dependencies:** WEB-001, WEB-017.
**Size:** S

---

## Assumptions log

1. Functions API surface consumed by this epic: `GET /api/v1/property`,
   `GET /api/v1/properties/autocomplete`, `POST /api/v1/estimates`, `POST /api/v1/leads`,
   `GET /api/v1/magic-links/verify`, `POST /api/v1/magic-links/re-issue`,
   POST /api/v1/estimates/{id}/revisions`, `POST /api/v1/reports/{token}/callback-requests`,
   `POST /api/v1/partner-share`, `POST /api/v1/events` — owned by the M1 API
   epic; this epic defines the contracts it needs.
2. Magic links are reusable within the 7-day window (not single-use) — simpler
   for the "Email to partner"/forwarding flow; documented in the privacy page.
3. Q1 default (renovation card disabled + "Coming soon") is assumed until Karan
   answers; the component is built so the badge/disabled state is a flag flip.
4. Narrative regenerates on re-run only when the total range shifts >5% —
   avoids Meta API spend on trivial sqft nudges.
5. Print-stylesheet PDF chosen over server-side (justified in Key decisions #2);
   revisit if emailed-PDF or pixel-identical output is required.

## Open questions

- **Q-WEB-1 (NEEDS-KARAN Q1):** Renovation card — disabled + "Coming soon" badge (recommended) or selectable → waitlist?
- **Q-WEB-2 (NEEDS-KARAN Q2):** Gate name field — required (recommended) or optional?
- **Q-WEB-3 (NEEDS-KARAN Q3):** Magic-link expiry 7 days OK?
- **Q-WEB-4 (NEEDS-KARAN Q4):** Sample report on landing — yes (recommended, fictional "Sample" address) or no?
- **Q-WEB-5 (NEEDS-KARAN):** Destination inbox for S9 callback emails (e.g. `team@feasly.com`)?
- **Q-WEB-6 (NEEDS-KARAN):** Lawyer review of privacy/terms before launch — who/when? (Launch blocker.)
- **Q-WEB-7:** Non-Calgary "join the waitlist" — confirmed deferred (message only, no capture) in M1? Current call: yes, deferred; logged.
- **Q-WEB-8:** Should the 24h nudge email for unclicked magic links (UX_FLOW scenario 4) be M1 or M4? Current call: M4+ (needs lead-status machinery); logged.
