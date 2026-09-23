# Feasly — User Validation Audit (think-as-user)

**Date:** 2026-09-23
**Status:** Audit of the implementation plans against the decided product direction
**Sources audited:** `plan/TECH_PLAN.md`, `plan/CODING_PATTERNS.md`,
`plan/epics/00`–`09`, `adr/ADR-001-architecture.md`, `plan/BUILD_PLAN.md`,
`plan/SCHEMA.md`, `plan/COST_ENGINE.md`, `plan/UX_FLOW.md`
**Guiding principle (standing):** think as a user — keep things simple, sticky,
trustworthy; never feel like a site trying to steal data.

This document audits; it does not redesign. Where the plans contradict each
other or leave a user-facing behavior unspecified, that is recorded as a gap —
not silently resolved. All story IDs and file paths below are cited so each gap
can be routed to its owning epic.

---

## 0. Resolution log (2026-09-23, post-audit reconciliation)

The audit was generated concurrently with the plan documents, so several of
its P0 findings were reconciled the same day. The table below is the current
state of every P0/P1 decision — it supersedes the stale verdicts in §§3–6
where they conflict. (Unresolved items keep their original severity and are
marked NEEDS-KARAN or P2.)

| Audit finding | Decision (2026-09-23) | Reflected in |
|---|---|---|
| P0-A consumer API has no owner | New **Epic 10 — Consumer API** (`epics/10-consumer-api.md`, CAP-001–CAP-013) owns the full M1 consumer surface | Epic 10 |
| P0-B canonical endpoint registry | Frozen in CAP-001; conformance amendments applied to epics 00/03/05, TECH_PLAN §§1.4/2.1/2.4, CODING_PATTERNS §§2/3 | CAP-001; this log |
| P0-C magic-link semantics | **Multi-use bearer, 7-day window** (default; NEEDS-KARAN confirms); embed relay codes strictly single-use | CODING_PATTERNS §2, HRD-002, CAP-003 |
| P0-D billing mechanism | **Internal `commission_invoices` + Stripe off-session PaymentIntents** (no Stripe Invoices); statuses `draft\|in_review\|finalized\|paid\|failed\|disputed\|voided`; Postmark HTML receipts in M1, server PDF deferred to M6 | TECH_PLAN §§2.4/5.1/5.3/5.4, epic 05 decision 6, BLD-012 |
| P0-E money units | **Integer cents end-to-end**; dollars at display only | Epic 02 decision 2, ENG-007, CODING_PATTERNS |
| P0-F migration framework | **dbmate**, `db/migrations/`, forward-only (no down scripts; local dev resets via fresh DB) | TECH_PLAN §10, CODING_PATTERNS §9, FND-006 |
| P0-G lead-status enum | `new\|contacted\|quoting\|won\|lost` | SCHEMA.md, TECH_PLAN §1.4/A4, FND-016 |
| P0-H package manager | **npm workspaces** | FND-002, CODING_PATTERNS |
| P0-I blur semantics | **Placeholder DTOs** — real figures never in the DOM pre-verification | CODING_PATTERNS §6, CAP-004 |
| P0-J timeline input | **One timeline question added to the gate** (CAP-002 enum `0-3mo/3-6mo/6-12mo/12+mo/exploring` → hot/warm/cold) | WEB-009, CAP-002 |
| P1-1 missing M4 epic | New **Epic 11 — Admin & Ops** (`epics/11-admin-ops.md`, OPS-001–OPS-010) | Epic 11 |
| P1-2 PIPEDA export/erase | CAP-012 (export), CAP-013 (erasure; financial records retained per HRD-007) | Epic 10 |
| P1-3 embed session strategy | **TECH_PLAN §2.2 wins**: `FEASLY_*` messages, no PII in postMessage, in-memory 12h JWT, `feasly_rt` param, 10-min single-use OTC, `POST /api/v1/embed/session` | BLD-008, BLD-009 |
| P1-4 schema reconciliation | New **FND-016** reconciliation pass before the baseline migration; `leads.phone` nullable | Epic 00 |
| P1-5 waitlist | **Message only in M1**; capture deferred to a later growth phase | PRD-006 |
| P1-6 duplicate-estimate semantics | Immutable snapshots; link resolves to the snapshot current at fetch; 90-day lead-dedupe rule (NEEDS-KARAN) | CAP-006 |
| P1-7 embed gate disclosure | Consent line names the builder from signed config; fail-closed if config fails | WEB-009, BLD-016 |
| P1-8 consent banner | WEB-018 (banner); CAP-010 (server-side consent gate on events) | Epics 03, 10 |
| P1-9 permit invoice gaps | `contract_signed_date` nullable + `value_source` enum; `tenants.estimated_value_autocharge` flag (default OFF — Elite pilot is confirm-value-required); NEEDS-KARAN Q1 | ATT-009, epic 06 |
| P1-10 rate limits/TTL/dunning | Estimates **20/hr/IP**; properties TTL 30d with "as of {date}" UI; dunning 7d grace / days 8–21 degraded / day 22+ suspended | CAP-001, WEB-004, TECH_PLAN §5.4 |
| P1-12 blob storage IaC | Storage account module added | FND-004 |
| P1-13 infra sizing | Functions **Flex Consumption FC1**; Postgres B1ms dev/staging → **B2s at launch** (30-day PITR); Angular 18 | FND-004, CODING_PATTERNS |
| P1-14/15 SEO gaps | SEO-011 (marketing pages), SEO-012 (sample report), SEO-013 (monthly stats refresh); stale-data UI indicator | Epics 04, 03 |
| E2 waitlist (stale GAP) | Resolved — see P1-5 above | — |
| E10 magic-link forwarded (stale BLOCKED) | Resolved — see P0-C above | — |

Story counts after reconciliation: 00: 16, 01: 12, 02: 10, 03: 18, 04: 13,
05: 16, 06: 9, 07: 16, 08: 12, 09: 17, 10: 13, 11: 10 → **162 stories total**.

---

## 1. Personas

**P-A — Homeowner on a builder's embedded estimator (Model B).**
Calgary homeowner on e.g. elitecraftbuilders.com/free-estimate. Never heard of
Feasly. Sees a "free build estimate" widget, expects the *builder's* tool. Low
trust budget, zero patience for friction, will bounce if anything feels phishy.

**P-B — Homeowner on feasly.com, marketplace phase (Model A, Phase 2).**
Returns to feasly.com directly. Higher intent, comparing builders. Needs to
believe the matching is fair (no rigged recommendations) and that their contact
details aren't sprayed to every builder in the city.

**P-C — Builder admin (Model B SaaS customer).**
Small-builder owner/office manager. Non-technical. Pastes one snippet, then
lives in the pipeline dashboard. Cares about: leads actually arriving, invoices
being fair and disputable, the embed never embarrassing them on their own site.

**P-D — Feasly ops (Karan).**
Watches funnels, billing health, and attribution flags; resolves disputes;
calibrates cost data; holds every launch gate. Needs one trustworthy view per
concern and an audit trail that survives a disagreement with a builder.

---

## 2. Happy-path walks

### P-A happy path (embed)
Homeowner opens the builder's estimate page. The loader snippet injects a
sandboxed iframe already themed with the builder's logo/accent plus a small
"Powered by Feasly" badge. They type an address, pick from autocomplete, see
the City property card, choose New Build → sqft/tier/garage/basement, and watch
the dark Analyzing beat. The blurred preview says "Your numbers are ready";
one "Unlock Full Numbers →" CTA opens the gate modal. They enter email + name
(phone optional, CASL checkbox unchecked), submit, and get "check your email."
The magic-link email points back to the *builder's* page with a one-time code;
the loader hands it to the iframe, the iframe exchanges it for a session, and
the full report renders inside the builder's site. What-if toggles, PDF, partner
share, and callback all work in place. The builder sees the lead in their
pipeline within seconds.

### P-B happy path (marketplace, Phase 2)
Homeowner runs the same wizard on feasly.com, verifies via magic link, reads
the report — then sees "Meet your matched builders": 2–3 cards with verified
badges, past projects, response-time stats, and a plain-language match summary
("Strong fit on project type and budget · typically responds in 6h"). They tick
the builders they're willing to hear from, consenting *per builder*. Chosen
builders receive the lead; the homeowner gets a post-project review request.
Elite Craft is nowhere in the pool, and nothing in the UI suggests hand-picking.

### P-C happy path (builder admin)
Builder signs up (business details, no document KYC), verifies email, accepts
the platform agreement clickwrap, picks flat or commission with the breakeven
nudge, and puts a card on file — only then is the embed key issued. They paste
one snippet, confirm "installed / loading / receiving leads" on the dashboard,
and work the pipeline: new → contacted → quoting → won/lost. Marking won
prompts for contract value (land excluded, labeled); a draft 1% invoice appears
with a 7-day review countdown; silence means auto-charge to the card on file.
Disputes pause the charge and go to Feasly ops with evidence attached.

### P-D happy path (ops)
Funnel dashboards show landing→report conversion by tenant; billing health shows
MRR, in-review aging, and dunning states; attribution flags surface permit
matches and homeowner confirmations the builder didn't report; each becomes a
draft invoice through one decision service with an append-only audit log.
Disputes arrive with evidence snapshots and a 5-business-day SLA. Monthly, the
permit cross-check runs itself; quarterly, quote comparisons feed a calibration
proposal that Karan approves into a new frozen cost-data version.

---

## 3. Edge-case matrix

For each: expected user experience (1–3 sentences), then **Captured** (owning
epic + story IDs) or **GAP** (what's missing + which epic it belongs in + rough
story sketch). Personas tagged per row.

| # | Edge case (personas) | Expected UX | Status |
|---|---|---|---|
| E1 | Address not found (A, B) | "We couldn't find that address. Check the spelling or try a nearby address." No dead end; miss is logged for metrics. | **Captured:** epic 01 `PRD-005` (404 `ADDRESS_NOT_FOUND`, copy, no long negative-cache); epic 03 `WEB-002` (error mapper), `WEB-004` (renders copy). |
| E2 | Non-Calgary address (A, B) | "Feasly currently covers Calgary only" + a way to hear when their city launches — or at minimum a clean, honest stop. | **GAP — scope contradiction.** `PRD-006` builds detection + `POST /api/v1/waitlist` (email+city capture) and `TECH_PLAN.md` §1.4 creates the `waitlist` table — but epic 03 **Non-goals** explicitly defers capture ("message only, no capture form in M1") and `UX_FLOW.md` S1 marks waitlist "email capture, future." **Proposed handling:** decide once (recommendation: defer capture to the M4/admin epic per the privacy posture; keep `PRD-006`'s detection + message, move the capture endpoint/table to M4). **NEEDS-KARAN** (already asked in `PRD-006` open questions). |
| E3 | City API down mid-wizard (A, B) | Wizard never strands: S1 shows "temporarily unavailable + Retry"; S4 failure falls back to an S1-style error panel with Retry; refresh on Analyzing resumes at S3. | **Captured:** `PRD-007` (timeout/retry/breaker/stale-flagged serve/503), `WEB-007` (failure fallback, resume-at-S3). **Caveat:** cache TTL contradicts itself — 30 days (`01-property-data.md` assumptions) vs 24h + stale-while-revalidate (`TECH_PLAN.md` §15.1 A11). Pick one; see §6 P1. |
| E4 | Expired magic link (A, B) | "This link has expired. Enter your email and we'll send a fresh one." — one step, no login maze. | **Captured:** `WEB-011` (re-issue flow), `TECH_PLAN.md` §2.2 (OTC expiry → re-issue UI). **Caveat:** endpoint naming is inconsistent (`/magic-links/reissue` vs `/magic-links/resend`, §6); and no story owns the re-issue endpoint (see E26-unowned-API). |
| E5 | Magic-link resend + rate limits (A, B) | Resend button with a visible 60s countdown; server enforces 60s per-email cooldown + 5/hr per (email+IP); same copy whether or not the email exists (no enumeration oracle). | **Captured:** `WEB-010` (countdown UI), `TECH_PLAN.md` §3.1 (cooldown + always-200). **Caveat:** the resend endpoint itself has no owning story (unowned consumer API, §6 P0). |
| E6 | CASL checkbox unchecked by default (A, B) | Marketing opt-in is unchecked; submitting the gate without it still delivers the report; `consent_ts` recorded regardless. | **Captured:** `WEB-009` (unchecked default, `marketing_consent` flag), `TECH_PLAN.md` §13.4. **GAP (P2):** no story owns the unsubscribe endpoint/mechanism for market-update emails (`TECH_PLAN.md` §13.4 promises "one-click opt-out" — belongs in the M4/admin epic). |
| E7 | Phone optional at gate (A, B) | Phone field clearly optional; report + callback-request flow still works (callback asks for phone then). | **GAP (P1):** `WEB-009` and `API-006` treat phone as optional, but `SCHEMA.md` defines `leads.phone text NOT NULL`. **Proposed handling:** migration makes `leads.phone` nullable (epic 00/01 schema story, e.g. amend `FND-007` baseline before it ships). |
| E8 | Lead submits gate, never clicks link (A, B) | Lead is captured at submit (no silent loss); a 24h nudge email follows. | **Partially captured:** `WEB-009` (lead persisted pre-click). **GAP (P1):** the 24h nudge is deferred to "M4+" (`UX_FLOW.md` #4, `WEB-017` Q-WEB-8) but **no M4 epic exists** — there is no story for the nudge email, its template, or its scheduler. Belongs in a new M4/admin epic (see §6 P0-JF). |
| E9 | Duplicate estimate, same email+address (A, B) | New inputs create a new versioned snapshot; the report header shows "Updated {date}". Old snapshots are never silently overwritten. | **Partially captured:** `WEB-012` (new snapshot + "Updated {date}"), `API-006` (90-day email+address dedupe). **GAP (P1):** (a) what the *existing* magic link resolves to after a second estimate is unspecified — latest snapshot or the snapshot the link was issued for? (`WEB-013` says the URL is stable and "snapshots version underneath," implying latest, but no story defines the resolution rule); (b) dedupe "updates the existing lead" — which fields update? does `lead_score` recompute? is a new magic link emailed? — unspecified; (c) the 90-day rule itself is **NEEDS-KARAN** (`TECH_PLAN.md` §14.10) but `API-006` builds it as decided. Proposed: one story in the consumer-API epic defining duplicate-estimate semantics end to end. |
| E10 | Magic link forwarded to someone else (A, B) | Anyone with the link sees that report (accepted bearer semantics, disclosed in the privacy page); partner-share mints a *separate* bearer so the owner's link stays private. | **Captured as designed:** `UX_FLOW.md` #6, `TECH_PLAN.md` §3.1, `WEB-014`/`TECH_PLAN.md` §2.1-step-7 (separate bearer per share). **BLOCKED on a P0 decision:** single-use vs multi-use is contradicted — `TECH_PLAN.md` §3.1/`WEB-011`/`UX_FLOW.md` say multi-use bearer; `CODING_PATTERNS.md` §2 ("single-use-on-verify") and `HRD-002` ("used token rejected on second use") say single-use. Forwarding only works under multi-use; the audit must not pick silently — see §6 P0. |
| E11 | Payment failure on commission auto-charge (C) | Builder is told immediately what's wrong and how to fix it (update card / retry); the invoice doesn't vanish into a retry loop; dunning states are visible on their dashboard. | **Captured:** `BLD-012` (failed → dunning), `BLD-013` (retry schedule + banners), `TECH_PLAN.md` §5.4. **Caveat:** the charge mechanism contradicts itself — Stripe draft **Invoices** with `auto_advance` (`TECH_PLAN.md` §§2.4/5.1) vs internal `commission_invoices` + off-session **PaymentIntents** (epic 05 decision 6, `BLD-012`). The status enums differ accordingly (`in_review` vs `disputed`, `void` vs `voided`). See §6 P0. |
| E12 | Dunning degradation of embed (C; A's experience) | The builder's page never breaks: the iframe area degrades to a "temporarily unavailable — contact {builder} directly" card; lead-gen pauses; full service restores within minutes of payment. | **Captured:** `BLD-013` (day 8–21 degraded, day 22+ suspended), `TECH_PLAN.md` §4.1/`§5.4` (loader renders fallback card on `degraded:true`). **Gaps (P2):** (a) day boundaries differ — 8–21/22+ (`BLD-013`) vs 7–30 (`TECH_PLAN.md` §5.4); (b) no mechanism specified for degrading an *already-open* iframe session mid-visit (config is fetched at load); belongs in epic 05 as a `BLD-013` follow-up (poll-or-push config recheck). |
| E13 | Embed blocked by builder's CSP / ad-blocker (A, C) | Page layout stays intact; homeowner gets a plain "Get your free build estimate →" link (attribution preserved via tenant slug); `<noscript>` users get the same. | **Captured:** `TECH_PLAN.md` §4.1 (fallback card, `?t={slug}` attribution, noscript), `BLD-006` (CSP install docs). |
| E14 | Homeowner choosing among 2–3 matched builders (B) | Post-report "Meet your matched builders": cards with verified badge, projects, reviews, response stats, one-line match summary; homeowner picks 1–3 (or none); honest empty state when <2 qualify; consent captured per builder. | **Captured (Phase 2):** `MKT-006` (match UI), `MKT-007` (per-builder PIPEDA consent), `MKT-004` (Elite excluded by config). Sequencing gate is explicit (epic 08 header). |
| E15 | Builder disputing an attribution invoice (C, D) | Within the 7-day window the builder disputes with a reason + evidence; the charge pauses; Feasly ops decides within 5 business days with rationale; everything is audit-logged. | **Captured:** `ATT-006` (dispute reasons, evidence rules, ops SLA), `BLD-012` (dispute button). **Caveat:** disputed-invoice status contradicts — `disputed` (epics 05/06) vs "stays `in_review`" (`TECH_PLAN.md` §§2.4/5.3). See §6 P0. |
| E16 | Permit-match auto-invoice for unreported win (C, D) | Monthly job finds a permit matching a lead; a draft invoice is created (badge "Auto-detected — please confirm contract value"); builder corrects/confirms in the review window; silence finalizes on the estimated value per the agreement. | **Captured:** `ATT-003` (matching pipeline), `ATT-005` (auto-invoice path), `ATT-008` (14-day SLA). **Gaps (P1):** (a) `ATT-001`'s `commission_invoices` requires `contract_signed_date NOT NULL`, but a permit match has no signed date (permit `issued_date` as proxy is unspecified); (b) `value_source='permit_estimate'` is referenced by `ATT-003` but the column doesn't exist in the schema; (c) auto-charging an *estimated* value is **NEEDS-KARAN** (`06-attribution.md` Q1 — recommendation: confirm-value-required for the Elite pilot). |
| E17 | Builder switching plans mid-cycle flat↔commission (C) | Switch takes effect immediately with proration stated up front; flat→commission cancels at period end; commission→flat starts now; already-earned draft invoices stay on their original track. | **Captured:** `BLD-014`, `TECH_PLAN.md` §5.5. Minor status-name friction (`in_review` vs `draft`) rides the §6 P0 invoice-model decision. |
| E18 | PDF download (A, B) | "Download PDF" produces a branded, print-clean PDF (figures, assumptions, disclaimer, "Prepared {date}") via the print stylesheet — no new infra. | **Captured:** `WEB-014`, `TECH_PLAN.md` §2.1-step-7 / §15.1 A2. **Contradiction (P1):** `BLD-012` requires *server-side* invoice PDFs attached to receipt emails, while `TECH_PLAN.md` defers server-side PDF (Gotenberg) to M6. Decide: either scope invoice receipts to Postmark-hosted HTML receipts in M1, or pull a minimal server-side PDF story into epic 05. |
| E19 | Email-to-partner share (A, B) | Partner enters an email, gets their own magic link to the same estimate; inline "Report sent to {email}." The owner's link is never the one forwarded. | **Captured:** `WEB-014`, `TECH_PLAN.md` §2.1-step-7 (`report_shares` table, fresh bearer). **Gap (P2):** no abuse control specified (rate limit / max shares per estimate / partner-email validation beyond format) — belongs in the consumer-API epic. |
| E20 | Callback request (A, B) | Inline panel: name prefilled, phone required here, time window → "Thanks — we'll call you {window}." Team gets a Postmark email; client never sees the destination address. | **Captured:** `WEB-014`, `TECH_PLAN.md` §2.1-step-7. **Gaps:** (a) destination inbox is **NEEDS-KARAN** (`WEB-014`); (b) the endpoint (`POST /api/v1/callback-request` vs `POST /api/v1/r/{token}/callback`) is unowned and inconsistently named — consumer-API epic, §6 P0; (c, P2) phone should prefill from the gate when already provided (`WEB-014` only prefills name). |
| E21 | Builder's card expiring (C) | Builder is warned before expiry, replaces the card with no gap in embed service (old method detached only after the new one succeeds). | **Partially captured:** `BLD-004` (replace flow, no-gap detach), `TECH_PLAN.md` §5.2 (`payment_method.detached` webhook). **GAP (P2):** no proactive expiry-soon notification story (Stripe sends its own, but no Feasly-owned reminder + dashboard banner) — belongs in epic 05 as a `BLD-004`/`BLD-013` follow-up. |
| E22 | Homeowner revoking consent — PIPEDA (A, B) | Self-serve export and erasure ("download my data / delete my data"), authenticated via magic link, with clear consequences stated (e.g. report links stop working). | **GAP (P1):** `TECH_PLAN.md` §13.4 promises `GET /api/v1/privacy/export` and `DELETE /api/v1/privacy/erase` with "stories in the hardening epic" — **no story in epic 09 (or anywhere) implements them.** Proposed: two stories in epic 09 (`HRD-0xx`): export (data inventory per user) and erasure (cascade rules incl. financial-record retention for invoices — legal input via `HRD-007`). Launch-blocker-adjacent: PIPEDA access rights apply from first email collected. |
| E23 | Estimate inputs changed after report issued — re-run immutability (A, B) | Tier toggle / sqft re-run creates a *new* immutable snapshot; the URL stays stable; header shows "Updated {date}"; narrative regenerates only on material (>5%) change. | **Captured:** `WEB-013` (debounced, last-write-wins, new rows), `SCHEMA.md` (no UPDATEs on `estimates`). **Gap (P2):** no estimate-history view — a user who toggles three times can't see or revert to an earlier snapshot; belongs in epic 03 as a `WEB-013` follow-up. |
| E24 | Community page with no assessment data (B, SEO) | Pages only exist for communities with real data; build is reproducible from the aggregates JSON + pinned cost-data version. | **Partially captured:** `SEO-001` (top-40 by record count filters out empties), `SEO-002` (reproducibility test). **GAP (P2):** build-failure mode unspecified — if Socrata is down during CI when the aggregates JSON must refresh, does the build fail, retry, or ship stale pages? Belongs in epic 04 (`SEO-001` follow-up). |
| E25 | API consumer with revoked key (M5) | Revocation takes effect immediately (≤60s); revoked calls get `401 INVALID_API_KEY`; usage metering excludes rejected calls. | **Captured:** `API-002` (revocation), `API-003` (401 envelope), `API-007` (429s not metered). |
| E26 | MCP estimate vs web estimate consistency (M5) | Same inputs + same cost-data version → byte-identical outputs across web handler, REST, and MCP tool. | **Captured:** `API-013` (tri-surface contract tests on shared fixtures), `API-001` (shared service layer). |

**The unowned-API note (applies to E4, E5, E9, E19, E20):** a whole consumer
API surface referenced by `WEB-009`–`WEB-014` has **no owning epic**: the lead
gate (`POST /api/v1/leads` for web), magic-link verify/resend/re-issue, report
fetch (`GET /api/v1/r/{token}`), what-if re-runs, partner share, callback
request, analytics events (`POST /api/v1/events`), and the narrative queue
worker (`TECH_PLAN.md` §2.1-step-5). Epic 03's assumptions say these are "owned
by the M1 API epic" — no such epic exists. `ENG-009` owns only
`POST /api/v1/estimate`; `PRD-002`/`PRD-003` own only the property endpoints.
This is the single largest structural gap: **M1 cannot function without it.**
See §6 P0-A.

---

## 4. Gaps — user perspective (harsh read)

These are written as the user would feel them, not as engineering tickets.

1. **The embed gate doesn't disclose who gets the data (P-A, P1).** The S6
   microcopy (`WEB-009`) says "We'll email your full report" — but on a
   builder's embed, name/email/phone flow to *the builder's* pipeline. A
   homeowner who thought they were using an anonymous calculator discovering
   their details went to a sales team is exactly the "data-stealing site"
   feeling the standing principle forbids. PIPEDA meaningful consent requires
   disclosing this. **Proposed:** tenant-aware gate copy ("Your details go to
   {builder} so they can follow up") — one story in epic 05 (`BLD-007`
   follow-up), with the copy reviewed under `HRD-007`. Related: `BLD-008`
   fires `feasly:lead.created` carrying name/email/phone/timeline to the
   parent page for "builder CRM," while `TECH_PLAN.md` §4.3 specifies
   `FEASLY_LEAD_EVENT` with *no PII* — the two specs contradict (§6 P1). Even
   once unified, PII-over-postMessage must rest on the disclosed consent in
   this gap.

2. **Magic-link email for the embed can land the user on a broken page
   (P-A, P2).** The email's primary link points to the *builder's* page with
   a one-time code. If the builder's page is slow, the snippet was removed, or
   a deploy broke the mount point, the primary path is dead. The secondary
   plain link (`TECH_PLAN.md` §2.2 fallbacks) mitigates — but only if the
   email clearly labels which link to use when the first "doesn't load," and
   only if `BLD-015`'s embed-health monitoring is actually watched by ops.

3. **Refreshing the builder's page loses the report (P-A, P2).** The iframe
   session lives in memory by design (`TECH_PLAN.md` §2.2: no cookies/storage
   in the iframe); the OTC is stripped from the URL after relay. A refresh
   therefore boots the iframe back to its landing state — the report
   "disappears." Expected handling: keep the OTC in the *builder-origin*
   `sessionStorage` (survives reload, dies with the tab) so the loader can
   re-relay on boot; or accept the behavior and say so in the email
   ("bookmark this email — your link re-opens your report"). Belongs in epic
   05 as a `BLD-009` follow-up. (Under the competing `BLD-009` cookie +
   localStorage design this problem doesn't exist — which is why the
   session-strategy decision in §6 is P1 before any embed code is written.)

4. **A second estimate confuses the report (P-A, P-B, P1).** "Estimate
   another address" keeps my email (`WEB-012`) — but do I hit the gate again
   for address #2? Nothing specifies a recognized-email shortcut, so the
   happy path forces a full re-gate on an already-verified user — pure
   friction. And E9's link-vs-snapshot ambiguity means the user can't tell
   whether their old email link shows old or new numbers. Both belong in the
   consumer-API epic (§6 P0-A).

5. **The blur treatment is either secure or it isn't (P-A, P-B, P0).**
   `WEB-008` + `TECH_PLAN.md` §2.1-step-3: the API returns `{blurred:true}`
   placeholders and real figures are *never in the DOM* (view-source safe).
   `CODING_PATTERNS.md` §6: blurred money regions are *real values in the
   DOM* with CSS blur. These are mutually exclusive. If the DOM variant
   ships, "we never see your numbers until you verify" is a lie anyone can
   inspect. Decide for placeholders before M1.

6. **Check-in emails can read as surveillance (P-B, P2).** `ATT-004`'s
   day-45/90/120 "how's your project going — which builder did you sign
   with?" one-click survey is inherently interrogative. The copy (`HRD-007`)
   must stay in the helpful register ("running into permit delays? here's
   what others hit at this stage"), and the CASL basis for non-marketing
   check-ins to users who *didn't* opt in should be stated in the privacy
   copy — currently unaddressed.

7. **Permit-match auto-invoice on an estimated value will feel like a fine
   (P-C, P1).** `ATT-003`/`ATT-005` create draft invoices from permit data
   with estimated contract values; the 7-day review window is the defense.
   But a builder's first experience of the platform being "we detected a
   permit and billed you $X on our estimate" is the highest-trust-risk moment
   in the whole commercial track — especially for the Elite pilot. This is
   why `06-attribution.md` Q1 (**NEEDS-KARAN**) recommends
   confirm-value-required mode for the pilot. Do not launch the pilot without
   that call.

8. **Stale assessment data is never shown as stale (P-A, P-B, P2).**
   `PRD-007` flags `stale:true` when serving past-TTL City data during an
   outage, but no web story renders any indicator. A report whose land basis
   is a month-old snapshot should say so ("assessed value as of {date}") —
   the standing trust principle demands it. Belongs in epic 03 as a `PRD-007`
   consumer follow-up.

9. **No visible consent posture (all, P1).** `TECH_PLAN.md` §12 says tracking
   waits for the privacy notice to be "acknowledged," but no story owns the
   notice/banner itself, and `WEB-017`'s first-party events endpoint has no
   specified consent gate. A privacy-forward product with no visible privacy
   UI is a trust gap, not a legal one. Belongs in epic 03 (banner) + epic 09
   (policy).

10. **Degraded-embed honesty (P-A, P-C, P2).** The fallback card says the
    estimator is "temporarily unavailable" with the builder's phone number —
    honest, but it captures no lead and gives no restoration timeline. From
    the builder's side, a dunning-caused degradation they discover *from a
    customer* is an embarrassment; `BLD-013`'s banners only help if the
    builder logs in. Proposed: same-day email to the builder on every
    degrade/restore transition (epic 05, `BLD-013` follow-up).

11. **The gate collects `timeline` for scoring but never asks for it
    (P-C, P0).** `SCHEMA.md` and `TECH_PLAN.md` §2.1-step-4 derive
    hot/warm/cold from `timeline` at insert, and `FEASLY_LEAD_EVENT` ships the
    score to the builder — but the S6 screen spec (`UX_FLOW.md`) and
    `WEB-009` have **no timeline input**. The builder's "hot lead" signal is
    computed from a value the UI never collects. Either add the field to the
    gate (one question, high signal value) or define an explicit default and
    downgrade the score's prominence. Epic 03 + consumer-API epic, before M1.

---

## 5. Gaps — technical perspective

### 5.1 Consistency checks (as requested)

**Story-ID uniqueness.** PASS with a caveat. Every epic uses a unique prefix
(`FND-`, `PRD-`, `ENG-`, `WEB-`, `SEO-`, `BLD-`, `ATT-`, `API-`, `MKT-`,
`HRD-`) and numbering is sequential within each. Caveat: `TECH_PLAN.md`
cross-references sections, not story IDs, so traceability from plan → story is
manual for the M1 flows — acceptable once the consumer-API epic exists.

**Every endpoint referenced by web stories has an owning epic.** FAIL —
§3 E26 note. Unowned: `POST /api/v1/leads` (web gate), magic-link
verify/resend/re-issue, `GET /api/v1/r/{token}`, what-if, partner share,
callback request, `POST /api/v1/events`, the narrative queue worker. **P0-A.**

**Endpoint naming is canonical.** FAIL. The same operations are named
differently per document:
- Property: `POST /api/v1/property/autocomplete` (`TECH_PLAN.md`) vs
  `GET /api/v1/properties/autocomplete` (`PRD-002`) vs
  `GET /api/v1/property/search` (`WEB-002`).
- Estimate: `POST /api/v1/estimates` (`TECH_PLAN.md`, `API-005`) vs
  `POST /api/v1/estimate` (`ENG-009`, `WEB-007`).
- Gate: `POST /api/v1/estimates/{id}/gate` (`TECH_PLAN.md`) vs
  `POST /api/v1/leads` (`WEB-009`, `API-006`).
- Report: `/r/{token}` (`TECH_PLAN.md`) vs `/api/v1/reports/{token}`
  (`CODING_PATTERNS.md` §3).
- Magic links: `/magic-links/resend` (`TECH_PLAN.md`) vs
  `/magic-links/verify` + `/magic-links/reissue` (`WEB-011`) vs
  `/leads/{id}/resend-magic-link` (`CODING_PATTERNS.md`).
- Callback: `/r/{token}/callback` (`TECH_PLAN.md`) vs `/callback-request`
  (`WEB-014`, epic 03 assumptions).
- Embed session: `/embed/session` (`TECH_PLAN.md` §2.2) vs
  `/embed/auth/exchange` (`BLD-009`); config: `GET /api/v1/embed/config?key=`
  vs `GET /api/v1/embed/:key/config` (`BLD-007`); iframe route `/embed?key=`
  vs `/embed/{tenantKey}` (`BLD-007`) vs `/embed?builder=`
  (`CODING_PATTERNS.md` §7).
- Key prefixes: `ek_live_`/`fk_live_` (`TECH_PLAN.md`) vs `fc_…`
  (`BLD-001`) vs `feasly_live_`/`feasly_test_` (epic 07, `SCHEMA.md`) vs
  `feasly_sk_` (`CODING_PATTERNS.md` §3).
**P0:** freeze one canonical registry (recommend: own it in the consumer-API
epic + epic 05 for builder routes) before any M1 API code.

**Lead-status enum consistency.** FAIL. Three variants:
`new|contacted|qualified|closed|lost` (`SCHEMA.md`, `BUILD_PLAN.md`,
`TECH_PLAN.md` §1.4 — won maps to `closed`) vs
`new|contacted|quoting|won|lost` (`BLD-011`, epic 05 decision 8, `ATT-001`
migration). **P0** — the CHECK constraint ships in the M0/M1 baseline
migration; decide before it exists.

**Migration framework.** FAIL. `TECH_PLAN.md` §10.2 records the dbmate
decision; `CODING_PATTERNS.md` defaults to dbmate but says "Decide at M0";
`FND-006`'s acceptance criteria recommends **node-pg-migrate** ("expected").
Migration directories also differ: `db/migrations/` (`TECH_PLAN.md`) vs
`apps/api/migrations/` (`CODING_PATTERNS.md`) vs `infra/db/migrations/`
(`FND-007`). Forward-only vs down-scripts-for-local-dev also contradicts
(`TECH_PLAN.md` §9.3 vs `CODING_PATTERNS.md` §9). **P0** — M0 blocker.

**Magic-link semantics.** FAIL — single-use (`CODING_PATTERNS.md` §2 error
catalog, `HRD-002`) vs multi-use bearer (`TECH_PLAN.md` §3.1, `WEB-011`,
`UX_FLOW.md` #6). **P0** — E10 forwarding, S10 partner sharing, and report
re-opening all assume multi-use.

**Waitlist scope.** FAIL — message-only (epic 03 non-goals, `UX_FLOW.md` S1)
vs capture in M1 (`PRD-006`, `TECH_PLAN.md` §1.4 table). **P1**, NEEDS-KARAN.

### 5.2 Further contradictions found (not in the requested list)

- **Money units:** integer cents end-to-end (`TECH_PLAN.md`, `CODING_PATTERNS.md`
  §2, `SCHEMA.md`, all billing stories) vs integer dollars in epic 02
  (decision 2, `ENG-007` asserts `x % 1000 === 0`). **P0** — engine and API
  must agree before `ENG-001`/`ENG-009`.
- **postMessage contract:** three incompatible specs — namespaced `FEASLY_*`
  (`TECH_PLAN.md` §4.3, no PII) vs `feasly:*` (`BLD-008`, *with* PII) vs
  `ns:'feasly-embed-v1'` (`CODING_PATTERNS.md` §7). **P1** before embed build.
- **Iframe session strategy:** mutually exclusive — in-memory JWT, no storage,
  no `allow-same-origin` (`TECH_PLAN.md` §2.2) vs Partitioned cookie +
  `localStorage`, `allow-same-origin` (`BLD-009`; also `CODING_PATTERNS.md`
  §7). **P1** — the embed's entire auth design hinges on this.
- **Billing mechanism:** Stripe draft Invoices + `auto_advance`
  (`TECH_PLAN.md` §§2.4/5.1) vs internal invoices + off-session PaymentIntents,
  "do NOT use Stripe Invoices" (epic 05 decision 6, `BLD-012`). Status enums
  diverge with it. **P0.**
- **Schema columns referenced but never created:** `users.role`
  (`BLD-001`), `tenants.status` (`BLD-001`), `builder_sessions`
  (`TECH_PLAN.md` §3.4), `platform_agreements`/`agreement_acceptances`
  (`BLD-002`), `estimates.source` (`API-005`), `value_source`
  (`ATT-003`), `sla_breach` (`ATT-008`), `marketplace_eligible`
  (`TECH_PLAN.md` §15.1 A9). Parallel naming: `tenants.plan`
  (`BLD-003`/`ATT-001`) vs `plan_type` (`TECH_PLAN.md`); `embed_domains`
  vs `allowed_origins`; `embed_relay_codes` vs `embed_auth_codes`;
  `embed_degraded` vs `billing_status='degraded'`; `contact_phone` vs
  `branding.fallback_phone`; `estimate_path` vs `report_url_template`;
  `feasly_rt` vs `feasly_code`; OTC 24-byte/10-min vs 32-byte/15-min.
  **P1** — one schema-reconciliation pass before the M0 baseline migration.
- **Package manager:** npm workspaces (`TECH_PLAN.md`, `CODING_PATTERNS.md`,
  "Turborepo is NOT used") vs pnpm (`FND-002`, `ENG-001`). **P0** — M0.
- **Infra sizing:** Functions Flex Consumption FC1 (`TECH_PLAN.md` §8.1) vs Y1
  (`FND-004`); Postgres B2s prod + 30-day PITR (`TECH_PLAN.md` §10.1) vs B1ms
  + 7-day (`FND-004`); Angular 18+ vs 17+. **P1** — cost-affecting, decide at
  M0.
- **Rate limits:** estimates 20/**hr**/IP (`TECH_PLAN.md` §13.3) vs 20/**min**/IP
  (`HRD-005`); properties cache 30d vs 24h (see E3). **P1.**
- **Deprecation notice:** 12 months (`CODING_PATTERNS.md` §10) vs 6 months
  (`API-010`). **P2.**
- **Error codes:** `VALIDATION_ERROR` 400 vs 422; `PROPERTY_NOT_FOUND`
  vs `ADDRESS_NOT_FOUND` vs `CITY_NOT_SUPPORTED` vs web's `non_calgary`;
  `UPSTREAM_UNAVAILABLE` 502 vs `CITY_API_UNAVAILABLE` 503. **P2** — one
  error catalog.
- **Magic-link token in query string** (`GET /api/v1/magic-links/verify?token=`,
  `WEB-011`) contradicts `CODING_PATTERNS.md` §3 ("no query-string tokens…
  token travels in the URL path by design") and puts bearer tokens in server
  access logs. **P1** — path param or POST body.
- **MCP transport:** Streamable HTTP `POST /mcp/v1` (epic 07) vs "hosted SSE
  deferred" (`TECH_PLAN.md` §15.1 A12). **P2.**
- **`marketplace_invoices`** (`MKT-001`) duplicates `commission_invoices`
  instead of reusing it with a track discriminator, contradicting epic 08
  decision 7. **P2.**
- **Missing IaC:** `BLD-010` (logo upload) and `ATT-006` (dispute evidence)
  assume Azure Blob, but no epic owns the storage account/CDN. **P1.**
- **Unowned pages/routes:** `/how-it-works`, `/pricing`, `/faq`,
  `/sample-report` are in `TECH_PLAN.md` §6.1's prerender list and
  `SEO-005`'s FAQPage JSON-LD, but no story builds them. **P1** under the
  SEO-first directive.
- **Unowned operations:** Sheets auto-sync (`TECH_PLAN.md` §2.6, `SCHEMA.md`
  watermark) and the whole M4 admin surface (lead dashboard, admin auth,
  nudge email) have **no epic** — BUILD_PLAN's M4 exists, but epics jump
  from 03 to 05. **P0-JF/P1** (see §6).
- **Privacy endpoints promised, not built:** §3 E22. **P1.**
- **Narrative failure UX:** if the narrative queue fails, the report polls
  forever — no specified error state (`WEB-011`/`WEB-012` cover figures, not
  narrative). **P2.**
- **`setup_intent.succeeded` vs `payment_method.attached`** (`BLD-004` vs
  `TECH_PLAN.md` §5.2) for card-on-file; **`/won` vs `/report-won`**
  (`TECH_PLAN.md` §2.3 vs `BLD-012`); **`/api/webhooks/stripe`** (`FND-013`)
  vs **`/api/v1/webhooks/stripe`** (`TECH_PLAN.md` §3.4). **P2.**
- **Dashboard chicken-and-egg:** `BLD-004` gates "dashboard access" on
  `has_card=true`, but plan choice and card setup happen *in* the dashboard
  onboarding. Clarify onboarding vs full-dashboard gating. **P2.**
- **Onboarding approvals:** epic 05 decision 2 requires manual ops approval of
  the first N tenants; no story owns the approval action/UI. **P2** (epic 05).
- **Stale-link assumption:** `FND-015` assumes "max 5 active links per user,"
  but resend revokes prior links (max 1 per estimate) — stale. **P2.**
- **`narrative` type:** jsonb (`SCHEMA.md`) vs text (`TECH_PLAN.md`). **P2.**
- **`validateNarrative` regex** (`ENG-010`) extracts `$[\d,]+` — misses
  `$729K`-style figures. **P2.**
- **SEO-002** both "runs the frozen cost engine" and takes "precomputed
  ranges" via `publicRangesForCommunity()` — the build-time engine invocation
  is muddled. **P2.**
- **Analytics consent:** first-party `POST /api/v1/events` has no specified
  consent gate; initial state of `feasly.analytics_optout` undefined. **P2**
  (epic 03/09).
- **Sheets sync ships PII to US Google infrastructure** — Postmark US transit
  is disclosed (`TECH_PLAN.md` §14.11); Sheets is not. **P2** — add to privacy
  copy.

---

## 6. Prioritized gap list

### P0 — must fix before M1 (M1 cannot ship otherwise)

**P0-A. The consumer API has no owning epic.** The lead gate, magic-link
lifecycle, report fetch, what-if, partner share, callback, `POST
/api/v1/events`, and the narrative worker are referenced by `WEB-009`–`WEB-014`
but owned by nobody ("M1 API epic" in epic 03 assumptions doesn't exist).
**Proposed:** create the missing epic (call it the consumer-API track of M1,
or fold into epic 03 as a backend section) with one story per endpoint group:
gate+lead-create, magic-link send/verify/resend/re-issue, report fetch by
token, what-if re-run, share, callback, events ingest, narrative queue worker.
Each story carries the canonical route from P0-B and the multi-use semantics
from P0-E. **Owner: new epic / epic 03.**

**P0-B. Canonical endpoint registry.** §5.1. One registry story
(`FND-0xx` follow-up in epic 00): freeze every `/api/v1` route, method, and
auth model in a single table in `TECH_PLAN.md`, and amend the contradicting
stories (`PRD-002`/`PRD-003`, `ENG-009`, `WEB-002`, `WEB-011`, `BLD-007`,
`BLD-009`) to match. **Owner: epic 00.**

**P0-C. Magic-link semantics: single-use vs multi-use.** §3 E10, §5.1. Audit
recommendation: **multi-use bearer for the 7-day window** (matches
`UX_FLOW.md` #6, forwarding, partner shares, "report as an artifact" mental
model); fix `CODING_PATTERNS.md` §2 and `HRD-002`'s "rejected on second use"
test. This is a product-security call, not just docs — record the decision in
`TECH_PLAN.md` §3.1. **Owner: epic 09 (HRD-002) + docs.**

**P0-D. Billing mechanism: Stripe Invoices vs PaymentIntents.** §3 E11, §5.2.
The invoice status enum, dispute flow, dunning webhooks, and receipt emails
all fork on this. Audit recommendation: **PaymentIntents + internal
`commission_invoices`** (epic 05 decision 6 — keeps the 7-day review window
under Feasly's control); then rewrite `TECH_PLAN.md` §§2.4/5.1/5.3's invoice
language and unify on `draft|in_review|finalized|paid|failed|disputed|voided`.
**Owner: epic 05 (`BLD-012` follow-up) + `TECH_PLAN.md`.**

**P0-E. Money units: cents vs dollars.** §5.2. Epic 02 stands alone on dollars;
everything else is cents. Audit recommendation: **integer cents** (matches
Stripe, `SCHEMA.md`, all billing stories); amend epic 02 decision 2 and
`ENG-007`'s assertions. **Owner: epic 02.**

**P0-F. Migration framework + location.** §5.1. `TECH_PLAN.md` §10.2 records
dbmate; `FND-006` expects node-pg-migrate; three directory candidates.
Audit recommendation: **dbmate, `db/migrations/`, forward-only** (per the
already-recorded decision); amend `FND-006`/`FND-007` and `CODING_PATTERNS.md`
§9. **Owner: epic 00.**

**P0-G. Lead-status enum.** §5.1. Three variants; the CHECK ships in the M0/M1
baseline. Audit recommendation: **`new|contacted|quoting|won|lost`**
(epics 05/06 — matches the pipeline UI the builder actually uses); migrate
`SCHEMA.md`, `TECH_PLAN.md` §1.4, `BUILD_PLAN.md` M4. **Owner: epic 00
(`FND-007`) + docs.**

**P0-H. Package manager.** npm vs pnpm (§5.2). Decide at M0; amend `FND-002`
or `CODING_PATTERNS.md`. **Owner: epic 00.**

**P0-I. Blur implementation.** §4 gap 5. Decide **placeholder DTOs, never real
values in DOM** (per `WEB-008`/`TECH_PLAN.md`); amend `CODING_PATTERNS.md` §6.
**Owner: epic 03.**

**P0-J. Timeline input for lead scoring.** §4 gap 11. Add the field to the S6
gate (one question, highest-value signal for the builder) or formally default
it and downgrade the score. **Owner: epic 03 (`WEB-009`) + consumer-API epic.**

### P1 — must fix before launch (pilot / public)

- **P1-1. M4 epic is missing.** Admin lead dashboard, admin auth, Sheets
  auto-sync, 24h nudge email, unsubscribe mechanism. BUILD_PLAN promises M4;
  no epic file exists. Create `plan/epics/10-admin-ops.md` (or equivalent)
  before M4 starts. Absorbs E8, E22-support, §5.2 unowned-ops items.
- **P1-2. PIPEDA export/erase endpoints.** §3 E22 — promise exists in
  `TECH_PLAN.md` §13.4, stories don't. Two stories in epic 09 + legal input
  via `HRD-007` (financial-record retention rules for erasure).
- **P1-3. Embed session strategy + postMessage contract + PII.** §5.2 —
  `TECH_PLAN.md` §2.2 vs `BLD-009`; `FEASLY_*` vs `feasly:*`; PII in
  `feasly:lead.created`. One decision story in epic 05, then conformance
  amendments to `BLD-006`–`BLD-009` and `TECH_PLAN.md` §§2.2/4.3. Do not
  write embed code before this.
- **P1-4. Schema reconciliation.** §5.2 — missing columns (`users.role`,
  `tenants.status`, `builder_sessions`, agreement tables,
  `estimates.source`, `value_source`, `sla_breach`, `marketplace_eligible`)
  and parallel names (`plan`/`plan_type`, `embed_domains`/`allowed_origins`,
  `embed_relay_codes`/`embed_auth_codes`, `feasly_rt`/`feasly_code`,
  `contact_phone`/`fallback_phone`, `estimate_path`/`report_url_template`).
  One `FND-007` amendment story before the baseline migration.
- **P1-5. Waitlist scope.** §3 E2 — capture vs message-only. **NEEDS-KARAN.**
- **P1-6. Duplicate-estimate semantics.** §3 E9 — link resolution rule,
  dedupe update semantics; 90-day rule itself **NEEDS-KARAN**.
- **P1-7. Embed gate consent disclosure.** §4 gap 1 — tenant-aware copy
  disclosing lead routing to the builder; `HRD-007` review. Epic 05.
- **P1-8. Consent banner + analytics gating.** §4 gap 9, §5.2 — the notice
  UI story (epic 03) and the events-endpoint policy (epic 09).
- **P1-9. Permit auto-invoice gaps.** §3 E16 — `contract_signed_date` NOT
  NULL vs permit flow; `value_source` column; pilot auto-charge mode
  **NEEDS-KARAN**.
- **P1-10. Contract hygiene:** rate limits (20/hr vs 20/min), properties
  TTL (30d vs 24h), dunning day boundaries, `VALIDATION_ERROR` 400/422,
  magic-link token in query string (move to path/body), key prefixes
  (`ek_`/`fc_`/`feasly_`), webhook paths, `/won` vs `/report-won`,
  `setup_intent.succeeded` vs `payment_method.attached`, config/iframe route
  variants. One "contract freeze" story per affected epic, or a single
  cross-epic sweep story in epic 00.
- **P1-11. Invoice PDFs vs M6 deferral.** §3 E18 — decide minimal scope
  (HTML receipts now vs server-side PDFs pulled into epic 05).
- **P1-12. Blob storage IaC.** §5.2 — logos + dispute evidence; no epic
  owns it. Fold into epic 00's infra stories.
- **P1-13. Infra sizing decisions.** Functions plan, PG SKU, backup
  retention, Angular 17 vs 18 — cost-affecting; decide at M0 (epic 00).
- **P1-14. SEO pages.** `/how-it-works`, `/pricing`, `/faq`, `/sample-report`
  — referenced by `TECH_PLAN.md` §6.1 and `SEO-005` but story-less. Epic 04
  (sample report gated on **NEEDS-KARAN** Q4).
- **P1-15. community-stats refresh timer.** `TECH_PLAN.md` §§1.1/2.5 promise
  it; no story. Epic 04.
- **P1-16. `leads.phone` nullable.** §3 E7 — amend baseline migration.

### P2 — Phase 2 / polish (do not block M1 or the pilot)

Duplicate-invoice table reuse (`marketplace_invoices`), deprecation-notice
period, full error-code catalog, MCP transport wording, narrative-failure UX,
stale-data UI indicator, iframe-refresh session loss, mid-session dunning
degrade, share abuse limits, partner-share branding for embed tenants,
card-expiry proactive warning, phone prefill at callback, check-in CASL basis,
builder-view report link, onboarding/dashboard gating, ops approval action,
SEO-002 engine-invocation clarity, `$K` regex in `validateNarrative`,
garage/basement v1-limitation disclosure in assumptions, parent-side
`lead.created` dedupe, analytics initial state, Sheets US-residency
disclosure, API estimate-response disclaimer field, `source='embed'` for
embed leads, `narrative` jsonb-vs-text, stale `FND-015` max-links assumption,
host naming (`app.` vs `embed.`), down-migration policy, estimate history
view, estimate-path validation, honeypot wiring in `WEB-009`, estimate URL
stability docs.

---

## 7. Assumptions log and open questions

**Assumptions this audit made** (flag if any is wrong):
- A1. Model B (embed) ships before Model A (marketplace); marketplace is
  Phase 2 — so embed-track contradictions are P1, marketplace issues P2.
- A2. `feasly.com` is the canonical consumer domain pending Karan's call
  (all routes written against it).
- A3. Magic-link expiry default 7 days (proposed everywhere; final call is
  Karan's — `TECH_PLAN.md` §14.8).
- A4. Cost data is *not* Karan's Sheet yet — calibration stories (`ENG-005`,
  `HRD-015`) assume the Sheet arrives before launch; nothing in the plans
  gates M1 on it beyond the draft-data warning.
- A5. "One magic-link gate" means exactly one email-verification step for the
  consumer flow; builder magic links (`TECH_PLAN.md` §2.3) are a separate
  auth surface, not a second consumer gate.
- A6. `NEEDS-KARAN` markers in source docs are binding — this audit did not
  resolve them.

**Open questions carried forward (NEEDS-KARAN):** magic-link expiry window;
lead-dedupe 90-day rule; waitlist capture vs message-only; confirm-value vs
auto-charge on permit-estimated invoices (Elite pilot); flat monthly price;
full-white-label tier; feasly.com vs alternatives; sample report on landing;
name required vs optional at gate; reno-card behavior; callback destination
inbox; lawyer for privacy/terms/platform agreement; LocalBusiness phone and
address for structured data; MCP registry publishing; marketplace weights at
Phase 2; Elite's marketplace entry; the cost Sheet itself; GitHub/Azure
access; MVP scope (lean vs broad). The full lists live in the source docs
(`TECH_PLAN.md` §14, epic open-question sections); the items above are the
ones that block validation closure.

---

## 8. Verdict

The plans describe a coherent, trust-first product and the scenario coverage
is genuinely strong — every failure state in `UX_FLOW.md` has a story, and
the commercial track's incentives (card-on-file, 7-day review, dispute pause,
degrade-don't-break) are well thought through. But **the plans do not
currently agree with each other on load-bearing contracts**: the consumer API
has no owning epic, magic-link semantics are contradicted, money units are
contradicted, the migration tool is contradicted, the lead-status enum is
contradicted, and the embed's entire session/postMessage design exists in two
mutually exclusive versions. None of these are refinements — they are
decisions that must be recorded before M0/M1 code starts, or three builders
will build three different products. Fix the ten P0 items, schedule the
sixteen P1 items before launch/pilot, and re-run this audit after the
decisions land.
