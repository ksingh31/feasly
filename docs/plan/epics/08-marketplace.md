# EPIC 08 — Marketplace (Model A)

**Owner:** TPM (implementation epics)
**Milestone coverage:** post-M5, Phase 2 — see sequencing banner
**Status:** not started — explicitly sequenced AFTER the embed business is live

> **PHASE-2 SEQUENCING — READ FIRST.** Per Karan's platform sequencing decision
> (2026-09-22), Model B (SaaS embed) ships FIRST and the marketplace (Model A)
> is built only after the embed business is live and trusted. **No story in
> this epic starts before:** (1) the embed track has at least one live paying
> builder (Elite Craft Builders pilot), (2) the attribution/collection layers
> from the attribution epic are in production, and (3) Karan explicitly
> green-lights Phase 2. **NEEDS-KARAN** gate on the epic as a whole.

## Goal

Let a Feasly homeowner choose among 2–3 system-matched builders via a
transparent match score — no hand-routing, no back-room allocation. Builders
see their full score breakdown; homeowners see a plain-language match summary.
Elite Craft Builders sits OUT of the matching pool initially (configuration,
not code) and may enter later only under identical rules plus affiliation
disclosure, once 10+ builders are active — a **NEEDS-KARAN** decision at the
time.

## Non-goals

- Builder bidding/auction mechanics (homeowner picks from matched builders;
  no price competition inside Feasly).
- In-app messaging between homeowner and builder (contact happens off-platform
  after consent; messaging is a later epic if ever).
- Multi-city marketplace (Calgary only until the embed business proves the model).
- Changing the 1% fee (non-negotiable per Karan; this epic implements it, not
  relitigates it).

## Key decisions

1. **Match score v1 weights (0–100):** project-type fit 30, budget-tier fit 25,
   service area 20, current capacity 15, historical close rate 10. Weights live
   in `marketplace_settings.weights` (config, tunable) — the numbers below are
   v1 defaults, signed off when Phase 2 is green-lit.
2. **Eligibility gate before scoring:** builder must be `verified` + active +
   serve the lead's community + have free capacity + score ≥ `min_score`
   (default 60). Top 3 by score are shown; fewer if fewer qualify.
3. **Transparency:** builders see their full component breakdown and rank;
   homeowners see a one-line match summary per builder
   (e.g. "Strong fit on project type and budget · typically responds in 6h").
   Raw weights are public in the docs — gaming the score is addressed by
   anti-gaming rules, not secrecy.
4. **Elite exclusion is configuration:** `marketplace_settings.elite_excluded`
   (default `true`); the matching query filters on it. Flipping it requires
   the Elite-entry checklist (MKT-011) and Karan's explicit approval.
5. **No human hand-routing — enforced in code:** the routing function accepts
   only `(lead, eligible_builders, settings)`; there is no override parameter,
   no admin "assign" button, and a test asserts the function signature has no
   manual-input path. Routing decisions are written to an append-only audit log.
6. **Consent per builder (PIPEDA):** the homeowner opts in separately for each
   builder they want contacted — meaningful, granular consent with timestamps;
   withdrawal stops sharing with that builder.
7. **Billing reuses the attribution epic's collection layers:** 1% of signed
   contract value on Feasly-sourced conversions; pipeline self-reporting tied
   to match score; Stripe auto-charge; homeowner post-close verification;
   monthly permit cross-check.

---

## Stories (dependency order)

### MKT-001 — Marketplace data model + migrations
**Description:** New tables: `marketplace_builders` (tenant_id FK unique,
status `pending|verified|suspended`, service_areas jsonb, budget_tiers text[],
capacity_slots int, response_sla_hours int default 24, close_rate numeric,
decline_count int, avg_response_hours numeric, verified_at), `marketplace_settings`
(city_id FK, elite_excluded boolean default true, min_score int default 60,
max_choices int default 3, weights jsonb), `match_decisions` (lead_id FK,
candidate_builder_ids uuid[], scores jsonb, chosen_builder_ids uuid[],
inputs_hash text, decided_by text default 'system', created_at — append-only,
no UPDATE/DELETE granted to the app role), `lead_builder_matches` (lead_id,
builder_id, score numeric, score_breakdown jsonb, homeowner_selected bool
default false, consent_ts, consent_withdrawn_at, response_status
`pending|accepted|declined|expired`, responded_at), `marketplace_invoices`
(lead_id, builder_id, contract_value_cents bigint, fee_cents bigint,
stripe_invoice_id, status), `builder_reviews` (builder_id, lead_id,
rating 1–5, review text, created_at).

**Acceptance criteria:**
- Migration applies cleanly on a fresh DB and on the M5 schema; down-migration
  tested in CI.
- App DB role has no UPDATE/DELETE on `match_decisions` (assert via
  `has_table_privilege` in a migration test).
- Seed script creates 5 fictional Calgary builders with varied profiles for
  local dev (clearly labeled fictional).

**Dependencies:** Phase-2 gate (epic header); tenants model (M0); attribution
epic's conversion events (for MKT-009 wiring later).
**Size:** M

### MKT-002 — Match-score engine
**Description:** Deterministic scorer: for each eligible builder compute the
five weighted components (project-type fit: builder's declared project types
vs lead's project_type; budget-tier fit: lead's tier vs builder's budget_tiers;
service area: lead community ∈ builder service_areas; capacity: free slots /
total slots scaled; close rate: trailing-90-day Feasly close rate). Pure
function, unit-tested, weights injected from `marketplace_settings`.

**Acceptance criteria:**
- 20 fixture leads × 5 fixture builders produce pinned scores (golden test);
  changing a weight in settings changes scores without a code change.
- Score is deterministic: same inputs → identical score + breakdown, twice.
- Breakdown JSON contains per-component `{ weight, raw, weighted }` so the
  builder UI can render it verbatim.
- Builders below `min_score` are excluded with reason code in the decision log.

**Dependencies:** MKT-001.
**Size:** M

### MKT-003 — Routing audit log + no-hand-routing enforcement
**Description:** Every routing decision writes one `match_decisions` row:
inputs hash (lead id + settings version + builder snapshot ids), all
candidates with scores, chosen set, timestamp. The routing entry point has
no manual-override parameter; there is no admin UI control that can assign a
builder to a lead.

**Acceptance criteria:**
- Routing function signature is `(lead, builders, settings)` — a test
  asserts no optional override / force-include parameter exists.
- Every match produces exactly one audit row; row content is sufficient to
  recompute the decision offline (replay test on 5 fixtures).
- Attempted UPDATE/DELETE on `match_decisions` from the app role fails
  (DB-level test).

**Dependencies:** MKT-002.
**Size:** S

### MKT-004 — Elite-exclusion config + governance tests
**Description:** Implement the Elite exclusion as configuration:
`marketplace_settings.elite_excluded=true` filters Elite's tenant out of
matching. Governance tests prove (a) exclusion is on by default, (b) flipping
it off without completing the MKT-011 checklist is blocked in code, (c) when
Elite is included it goes through the identical scoring path (no special-case
boost).

**Acceptance criteria:**
- With `elite_excluded=true`, Elite never appears in candidates even with a
  perfect score (test).
- Setting `elite_excluded=false` while the entry checklist is incomplete
  throws `EliteEntryBlockedError` (test).
- When included, Elite's score is computed by the same function — a test
  diffs the code path (no `if elite` branches in the scorer; grep test).

**Dependencies:** MKT-002, MKT-003.
**Size:** S

### MKT-005 — Builder self-serve onboarding + vetting checklist
**Description:** Public (pre-login) builder application flow: business profile,
license number, WCB + liability insurance document upload, 3 completed
projects with photos + addresses, 2 references, service areas (community
multi-select), budget tiers served, crew capacity (concurrent projects),
response-SLA acceptance checkbox, platform-agreement e-signature. Admin
review queue: approve / request-changes / reject with reasons. Approval flips
`marketplace_builders.status` to `verified`.

**Acceptance criteria:**
- Application cannot be submitted with any checklist item missing (client +
  server validation; server test).
- Admin approve/reject writes status + reason + actor to an audit trail.
- Rejected builders get the reason by email; can re-apply after 30 days.
- Platform agreement signing is blocked until the agreement copy is lawyer-
  finalized (HRD-008) — the UI shows "coming soon" otherwise.
- Uploaded docs are stored privately (signed URLs, not public).

**Dependencies:** MKT-001; HRD-008 (platform agreement copy).
**Size:** L

### MKT-006 — Consumer match UI (homeowner choice)
**Description:** Post-report screen "Meet your matched builders": 2–3 builder
cards, each with name/logo, verified badge, service areas, past projects
(photos), reviews (avg rating + count), response-time stat ("typically
responds in ~6h"), and the plain-language match summary. Homeowner selects
which builders may contact them (1–3, or none). Fewer than 2 qualifiers →
honest empty state ("Only 1 builder matched your project right now").

**Acceptance criteria:**
- Cards render all required fields from `lead_builder_matches` +
  `marketplace_builders` + `builder_reviews` (no hardcoded content).
- Match summary line is generated from the score breakdown by a fixed
  template (no LLM — deterministic copy).
- Empty states for 0 and 1 qualifiers are honest and offer "notify me when
  more builders join" (email capture).
- Mobile: cards stack, sticky "Continue" CTA.

**Dependencies:** MKT-002, MKT-003, MKT-010 (reviews feed the cards).
**Size:** L

### MKT-007 — Per-builder consent capture (PIPEDA)
**Description:** Granular consent: one checkbox per selected builder —
"I agree Feasly may share my name, email, phone, and project details with
{builder}." Consent recorded per builder in `lead_builder_matches.consent_ts`;
withdrawal (link in every builder email + account page) sets
`consent_withdrawn_at` and immediately stops sharing. Builder contact details
are released to the builder only after consent.

**Acceptance criteria:**
- Lead PII is not sent to any builder before that builder's `consent_ts` is
  set (test: builder API/panel shows redacted lead until consent).
- Each consent records timestamp + the exact copy version consented to.
- Withdrawal within 1 hour of consent still revokes (no dark-pattern delay);
  withdrawn leads are excluded from the builder's active list.
- Consent copy reviewed as part of HRD-007 legal review.

**Dependencies:** MKT-006; HRD-007 (consent copy).
**Size:** M

### MKT-008 — Anti-gaming: decline penalties, SLA tracking, nightly recalc
**Description:** Builders can't cherry-pick. Rules: declining a matched lead
within the SLA window costs 5 score points (decays over 90 days, tracked in
score history); failure to accept/decline within `response_sla_hours`
(default 24) records an SLA miss, published as `avg_response_hours` on the
profile and fed into the capacity component; nightly job recomputes
`close_rate` (trailing 90 days), `avg_response_hours`, and applies decay;
decline rate >40% over trailing 30 matches auto-flags the builder for admin
review; builders cannot see other builders' scores or bids.

**Acceptance criteria:**
- Fixture: builder declining 3 leads drops exactly 15 points before decay
  (unit test on the penalty function).
- SLA miss increments the miss counter and updates `avg_response_hours`
  (integration test with time-mocked responses).
- Nightly job is idempotent (re-running same day changes nothing — test).
- Flagged builders appear in the admin review queue with the decline-rate
  evidence attached.
- Builder-facing score view never includes other builders' data (auth test).

**Dependencies:** MKT-002, MKT-003.
**Size:** M

### MKT-009 — Marketplace billing (1% conversions)
**Description:** Conversion billing on Feasly-sourced wins, reusing the
attribution epic's collection layers: builder self-reports signed contracts
in their pipeline board (non-reporting degrades match score → suspension);
Feasly issues invoice for 1% of gross contract value (non-negotiable, excl.
land per platform terms); Stripe auto-charge against card on file with the
7-day review window; homeowner post-close verification email; monthly permit
cross-check flags unreported conversions for review. Dunning follows the
embed track's dunning runbook (HRD-013).

**Acceptance criteria:**
- Reported contract of $800,000 → invoice for $8,000 (1%, integer cents).
- Fee percentage is a constant, not per-builder configurable (test asserts
  no tenant-level override exists).
- Unreported conversion found by permit cross-check creates a dispute case
  in the ops dashboard.
- Failed auto-charge follows dunning steps (grace → retry → embed/marketplace
  visibility degradation, never silent).
- Every invoice links `lead_id` → `match_decisions` row (full provenance).

**Dependencies:** MKT-001, attribution epic (pipeline self-reporting,
permit cross-check), MKT-012 (ops dashboard surface).
**Size:** M

### MKT-010 — Builder reviews + close-rate feedback loop
**Description:** Post-project review flow: homeowner rates the builder 1–5 +
optional text after a conversion closes (or 60 days after first contact with
no conversion — "didn't proceed" reviews allowed but labeled). Reviews feed
the builder card (MKT-006) and the close-rate score component. Moderation:
builder can flag a review once; admin adjudicates; obvious fake reviews
removable with reason logged.

**Acceptance criteria:**
- Review request email sent once per closed/expired match (no duplicates —
  idempotency test).
- Builder profile shows average rating + count; <3 reviews shows "New —
  not enough reviews yet" (no misleading 5.0 from one review).
- Close-rate component uses trailing-90-day data only (test with old data
  excluded).
- Moderation actions are audit-logged with actor + reason.

**Dependencies:** MKT-001, MKT-006.
**Size:** M

### MKT-011 — Elite entry readiness checklist
**Description:** The gated path for Elite Craft Builders to enter the pool:
requires 10+ active verified builders, Elite passing the identical MKT-005
vetting, affiliation disclosure components (badge "Affiliated with Feasly"
on Elite cards, in match summaries, and in the platform agreement addendum),
and Karan's explicit written approval. Only then may
`marketplace_settings.elite_excluded` be flipped.

**Acceptance criteria:**
- Checklist UI in admin shows each criterion with live status
  (builder count, Elite vetting status, disclosure components shipped).
- Flip is blocked until all boxes are checked AND Karan's approval is
  recorded (two-key: checklist complete + approval flag).
- Disclosure badge renders on every Elite surface (visual regression test).
- **NEEDS-KARAN:** the entry decision itself, at the time.

**Dependencies:** MKT-004, MKT-005.
**Size:** S
**NEEDS-KARAN:** yes — the entry decision.

### MKT-012 — Marketplace ops dashboard
**Description:** Admin view: live matches (lead → candidates → chosen), score
distributions, decline/SLA flags, conversion pipeline, invoices + dunning
state, dispute cases from permit cross-checks, Elite-entry checklist status.
Read-only except for moderation actions (review adjudication, flag review).

**Acceptance criteria:**
- Dashboard loads p95 < 2s on 10k matches (seeded perf test).
- Every moderation action writes an audit entry with actor + timestamp.
- No control exists that assigns or re-routes a builder to a lead
  (complements MKT-003).

**Dependencies:** MKT-003, MKT-008, MKT-009.
**Size:** M

---

## Assumptions log

- A1: Phase-2 gate criteria (embed live + attribution layers in prod + Karan
  green-light) are checked by the TPM before any MKT story is scheduled.
- A2: v1 weights (30/25/20/15/10) and `min_score=60` are defaults; Karan
  signs off the final numbers at the Phase-2 kickoff (**NEEDS-KARAN** then,
  not now).
- A3: "Close rate" = Feasly-attributed signed contracts / consented matches,
  trailing 90 days; new builders start at the pool median (not zero) to avoid
  cold-start punishment.
- A4: Builders are `tenants` with a `marketplace_builders` row; the embed
  track and marketplace track share the tenant record.
- A5: The 1% fee base is gross construction contract value excluding land,
  per the platform pricing decision (2026-09-22).
- A6: Homeowner–builder contact happens off-platform after consent; Feasly
  does not build in-app messaging in Phase 2.

## Open questions

- Q1: At marketplace launch, is 2–3 matched builders the right count, or
  should low-supply launches show up to 5? (Recommendation: keep 3 max —
  choice overload hurts conversion; revisit with data.)
- Q2: Should the homeowner see the numeric score (e.g. "87/100") or only the
  plain-language summary? (Recommendation: summary only — numbers invite
  unhelpful precision arguments.)
- Q3: Response SLA default — 24h or 12h for hot leads? (Recommendation: 24h
  flat for v1; tiered SLAs add complexity before we have data.)
- Q4: Do declined-match penalties also apply when the homeowner withdraws
  consent before the builder responds? (Recommendation: no — builder
  shouldn't be punished for homeowner-side withdrawal.)
- Q5: **NEEDS-KARAN** at Phase-2 kickoff: final weight values, min_score,
  max_choices, and the Elite entry decision.
