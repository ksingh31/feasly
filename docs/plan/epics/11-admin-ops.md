# Epic 11 — Admin & Ops

**Status:** Draft for implementation — closes USER_VALIDATION.md §6 P1-1 (the missing M4 epic), E6 (unsubscribe), E8 (24h nudge), and the §5.2 unowned-operations items (Sheets sync, admin auth).
**Milestone coverage:** M4 (BUILD_PLAN's admin milestone) + ongoing operations.
**Schema:** `../SCHEMA.md` | Patterns: `../CODING_PATTERNS.md`

## Goal

Give Karan (P-D) one trustworthy view per concern — every lead, billing health, funnels, disputes, and cost-data calibration — plus the operational machinery that keeps the consumer and builder tracks honest: Sheets sync, the 24h nudge, CASL-compliant unsubscribe, and an ops alerting inbox. This is Feasly-internal: cross-tenant reads, admin-only auth, audit-logged actions. It does not duplicate epic 06's attribution decision logic or epic 09's legal copy — it consumes both.

## Non-goals

- Builder-facing dashboards (epic 05: `BLD-011` pipeline, billing pages). Ops views here are Feasly-internal; where a view resembles a builder view, it is read-only and cross-tenant.
- Attribution decision rules (epic 06: `ATT-002` decision service, `ATT-003`–`ATT-005` channels). OPS-009 resolves disputes *using* those rules; it does not redefine them.
- Privacy/terms/CASL copy itself (epic 09: `HRD-007`). OPS-005 implements the unsubscribe mechanics against the approved wording.
- Marketplace match/lead-allocation UI (epic 08, Phase 2).

## Key decisions (locked)

1. **Admin auth = magic link + allowlisted admin emails** (OPS-001). No passwords anywhere in the system (consistent with TECH_PLAN §3.5). Admin sessions reuse the first-party httpOnly cookie mechanism (TECH_PLAN §3.4); the allowlist is the authorization boundary.
2. **Postgres is the source of truth; Google Sheets is a read-through sync** (SCHEMA.md). The Sheets worker never writes back; conflicts resolve to Postgres, always.
3. **Commission invoices are internal `commission_invoices` + Stripe PaymentIntents** (epic 05 decision 6; canonical statuses `draft|in_review|finalized|paid|failed|disputed|voided`). All billing-health views read this table joined with Stripe, never Stripe alone.
4. **Dunning timeline is canonical:** 7d grace / days 8–21 degraded embed / day 22+ suspended (epic 05 decision 9). Ops alerting and the billing dashboard use these boundaries.
5. **Dispute resolution consumes ATT-006's rules** (reasons, evidence requirements, prior-relationship proof burden) — OPS-009 is the console, not a second rulebook.
6. **Calibration proposals are human-gated:** the console proposes, Karan approves each freeze (ties HRD-015). Nothing auto-publishes a cost-data version.
7. **No external actions beyond sanctioned sends:** ops emails (Postmark) and Stripe reads are the only outbound calls in this epic.

## Stories (dependency order)

### OPS-001 — Admin auth (magic-link + allowlist)
- **Description:** Feasly-internal authentication for Karan (and future ops staff). Email-ownership proof only; authorization = the admin allowlist. Guards every `/admin/*` route and all ops API endpoints in this epic.
- **Acceptance criteria:**
  - Admin login: enter email → if the email is on the admin allowlist, a magic-link email is sent; clicking it establishes a first-party `httpOnly; Secure; SameSite=Lax` session cookie (hashed session id in `builder_sessions`-style table with `role='admin'`), 24h sliding expiry. Non-allowlisted emails get the same "check your email" copy and no link is sent (no enumeration oracle).
  - Allowlist stored in a Feasly-operated table (`admin_allowlist(email citext PK, added_by, added_at)`), seeded with Karan's address; changes are audit-logged.
  - Every ops API endpoint enforces the admin session (missing/invalid → 401; non-admin → 403). Tenant scoping is bypassed by design (cross-tenant reads) — each cross-tenant read is logged with the admin's email.
  - **NEEDS-KARAN:** the initial allowlist (his email address; plus any delegate).
- **Dependencies:** CAP-003 (magic-link issuance semantics); epic 00 session-table migration.
- **Size:** S
- **NEEDS-KARAN:** admin allowlist — which emails?

### OPS-002 — All-leads explorer (M4 admin dashboard)
- **Description:** The cross-tenant lead view: every lead from every tenant, filterable, with a detail panel, notes, and history. This is BUILD_PLAN's M4 "admin dashboard" for leads. Distinct from ATT-007 (which is flag/SLA/dispute queues for attribution) — cross-referenced, not duplicated.
- **Acceptance criteria:**
  - Route `/admin/leads` (admin-authenticated): table with filters — lead_score (hot/warm/cold), status (`new|contacted|quoting|won|lost`), tenant, date range, source (web/embed/api/mcp), project_type, free-text search (name/email/address_key); cursor pagination per CODING_PATTERNS §3; CSV export of the filtered set.
  - Detail panel per lead: estimate summary (address, sqft, tier, ranges in cents), timeline, consent_ts, marketing_consent flag, `sheets_synced_at`, magic-link status (sent/used/expired), linked snapshots count, tenant attribution, source.
  - Notes thread (writes to `lead_notes`, append-only) and status-history view (reads `lead_status_history`); status changes from ops are audit-logged with the admin's email.
  - Bot-quarantine view: honeypot-flagged submissions (HRD-005) listed separately with approve/discard actions — quarantined, never silently dropped.
  - Erasure-request queue: `erasure_requests` in `requested` state appear here with the consequences statement and a confirm/execute action (executes CAP-013's cascade).
  - Test: admin A cannot see data outside their authorization scope is N/A (single org) — instead assert every cross-tenant read writes an audit row.
- **Dependencies:** OPS-001; CAP-013 (erasure execution); ATT-001 (`lead_notes`, `lead_status_history` tables).
- **Size:** M

### OPS-003 — Google Sheets auto-sync worker
- **Description:** The hourly timer that mirrors leads into Karan's Google Sheet for his daily view. Postgres stays the source of truth. (TECH_PLAN §2.6; SCHEMA.md watermark.)
- **Acceptance criteria:**
  - Timer Function (hourly): selects `leads` rows (joined to users/estimates summaries) where `sheets_synced_at IS NULL` or the lead was updated since the watermark; upserts into the configured Sheet via the service account (`google-sheets-service-account` in Key Vault); sets `sheets_synced_at=now()` per synced row.
  - Postgres-wins on any conflict; the worker never writes to Postgres except the watermark.
  - Failure handling: retry with backoff; after 3 consecutive failures, alert ops (OPS-006) and surface the lag on the lead-pipeline dashboard (TECH_PLAN §12).
  - Privacy: the Sheet contains lead PII on US Google infrastructure — the privacy page discloses this (copy via HRD-007; the Sheets US-residency disclosure gap from USER_VALIDATION §5.2 is closed by that copy, not by this worker).
  - **NEEDS-KARAN:** the destination Sheet / service-account sharing (manual Google-side step).
- **Dependencies:** OPS-001 (config surface can live in admin); OPS-006 (failure alerts).
- **Size:** M
- **NEEDS-KARAN:** share the target Google Sheet with the service account.

### OPS-004 — 24h nudge email for unverified leads
- **Description:** The UX_FLOW scenario-4 follow-up: a lead submitted the gate but never clicked the magic link. One nudge, 24 hours later. (E8 gap — deferred from M1 to this epic.)
- **Acceptance criteria:**
  - Timer Function (hourly): finds leads created ~24h ago whose magic link has no `used_at`; sends the Postmark nudge template ("Your build estimate is ready — here's your secure link") with a fresh link (reuses the resend path, revoking the unclicked one per CAP-003).
  - Exactly one nudge per lead (guard: `nudge_sent_at` on the lead row); users who verified in the meantime are excluded by construction.
  - Unsubscribe-aware: if the user opted out of check-ins (OPS-005) or filed a complaint, no nudge is sent; every nudge carries a one-click unsubscribe link (CASL: the nudge is a reminder of requested content, but opt-out is honored anyway).
  - Template copy reviewed under HRD-007 (helpful register, never surveillance-toned — cf. USER_VALIDATION §4-gap-6).
- **Dependencies:** CAP-003 (link issuance); OPS-005 (opt-out checks); epic 01 Postmark templates.
- **Size:** S

### OPS-005 — Unsubscribe center (one-click, CASL-compliant)
- **Description:** The E6 gap: `TECH_PLAN.md` §13.4 promises one-click opt-out on market-update emails, but no story owned it. Self-serve preferences, no login required.
- **Acceptance criteria:**
  - Every marketing/check-in/nudge email carries a signed one-click unsubscribe link (`/unsubscribe/{token}` — HMAC over `user_id`, 30-day validity, no login needed).
  - Preferences page: toggles for `market_updates` (the CASL gate checkbox) and `checkin_sequence` (ATT-004 45/90/120d cadence + OPS-004 nudge); unchecking takes effect immediately and is honored by ATT-004, OPS-004, and any marketing send within 1 hour.
  - CASL basis recorded: `marketing_consent` + `consent_ts` on the lead; withdrawal timestamp stored; transactional emails (magic links, receipts) are unaffected and the page says so plainly.
  - Copy matches HRD-007's approved CASL wording verbatim (diff test against approved copy).
- **Dependencies:** OPS-001 (admin view of opt-out rates); ATT-004 (cadence honors the flags); HRD-007 (wording).
- **Size:** M

### OPS-006 — Ops alerting inbox
- **Description:** Karan gets emailed when the platform needs a human: embed-health transitions, dunning transitions, attribution flags, and worker failures. Immediate, deduped, actionable.
- **Acceptance criteria:**
  - Alert classes (email to the ops inbox, Postmark):
    - **Embed health** (from BLD-015 signals): no ping 48h post-activation ("not installed"), pings but zero iframe loads 7d ("misconfigured?"), loads but zero leads 14d, any tenant entering dunning stages.
    - **Dunning transitions** (BLD-013): past_due → degraded (day 8) → suspended (day 22) → recovered; same-day email to the builder also fires on degrade/restore (USER_VALIDATION §4-gap-10 — builders never learn about degradation from a customer first).
    - **Attribution flags** (from ATT-007 queues): permit-match unreported 48h, homeowner-confirmed unreported 48h, reporting-SLA overdue.
    - **Worker failures:** Sheets sync 3 consecutive failures, narrative worker 3 consecutive failures, Stripe webhook 3 consecutive failures, permit job run failure.
  - Dedupe: one email per (tenant, transition) per 24h — no alert storms; every alert links to the relevant ops view (OPS-002/007/009).
  - Alert rules themselves are config (Feasly-operated settings table), not code — thresholds adjustable without a deploy.
  - **NEEDS-KARAN:** the ops inbox address (where these emails go).
- **Dependencies:** BLD-013, BLD-015 (signals); ATT-007 (flag queues); OPS-003, CAP-011 (worker health).
- **Size:** S
- **NEEDS-KARAN:** ops alert inbox address.

### OPS-007 — Billing-health dashboard
- **Description:** The money view: MRR, in-review aging, dunning states, webhook health. Read-only over Stripe + `commission_invoices`. (TECH_PLAN §12 billing-health dashboard.)
- **Acceptance criteria:**
  - Route `/admin/billing` (admin-authenticated): MRR from flat subscriptions (Stripe, synced); `in_review` commission invoices sorted by `review_due_at` (aging buckets: <48h, <7d, overdue); dunning states per tenant (`current|past_due|degraded|suspended` with `past_due_since`); paid/failed totals this month; dispute count + oldest open dispute (links to OPS-009).
  - Every figure drills down to the underlying invoice/tenant; all amounts in cents rendered as dollars at display (decision: cents end-to-end).
  - Webhook health panel: last `stripe_events` received, failure count, 3-consecutive-failure banner (links to OPS-006's alert history).
  - Read-only: no charge/refund/void actions here — invoice actions live in OPS-009 (disputes) and the builder flow (epic 05); this view never mutates billing state.
- **Dependencies:** OPS-001; BLD-012 (invoice lifecycle); ATT-006 (dispute states).
- **Size:** M

### OPS-008 — Funnel dashboards
- **Description:** Conversion visibility: landing→report by tenant, gate conversion, report opens. Feeds from CAP-010's events plus leads/magic-links. (TECH_PLAN §12 funnel dashboard; USER_VALIDATION P-D happy path.)
- **Acceptance criteria:**
  - Route `/admin/funnels` (admin-authenticated): per-tenant and aggregate funnels — landing → address → scope → preview → gate view → gate convert → report open; gate conversion rate; report-open rate; tier-toggle usage; what-if revision counts; share/callback/PDF action rates.
  - Date-range selector; tenant comparison view ("which builder's embed converts?"); CSV export.
  - Data sources: `POST /api/v1/events` aggregates + `leads` + `magic_links.used_at`; no PII in the dashboard (counts and rates only — drill-down stops at anonymized cohorts).
  - Builder-visible subset: each builder's own dashboard shows only their tenant's funnel (epic 05 BLD-011/Bld-015 surface — this story owns the ops-side cross-tenant view and the shared aggregation queries).
- **Dependencies:** OPS-001; CAP-010 (events); CAP-003 (`used_at` open tracking).
- **Size:** M

### OPS-009 — Dispute resolution console
- **Description:** The ops side of ATT-006: evidence snapshots, the 5-business-day SLA timer, accept/reject with rationale, audit-logged. The console applies ATT-006's rules — it does not restate them.
- **Acceptance criteria:**
  - Route `/admin/disputes` (admin-authenticated): open disputes sorted by oldest, each showing the ATT-006 reason enum, the builder's evidence snapshot (immutable at decision time), the invoice (status `disputed`, charge paused), and the SLA countdown (5 business days from dispute filing; business-day math in America/Edmonton).
  - Actions: accept (→ invoice `voided`, credit note if already paid, builder emailed with rationale) or reject (→ invoice resumes its track: back to `in_review` with a fresh 7-day window, builder emailed with rationale). Both write `audit_log` rows with actor = admin email.
  - `prior_relationship` disputes show the evidence-date-vs-handoff check result (ATT-006's server validation); `wrong_value` corrections recompute `commission_cents = round(value × 0.01)` and restart the review clock.
  - SLA breach (no decision in 5 business days) → escalates via OPS-006 alert; the dispute never auto-resolves in either direction (silence ≠ decision here, unlike invoice review).
  - Builders see status only (in their billing view, epic 05) — decision actions are ops-exclusive.
- **Dependencies:** OPS-001; ATT-006 (rules + evidence); ATT-007 (dispute queue feeds this console).
- **Size:** M

### OPS-010 — Calibration console
- **Description:** The human gate between quote comparisons and cost-data versions. Reviews `quote_comparisons` (HRD-014), proposes parameter adjustments, Karan approves each freeze (ties ENG-005/HRD-015).
- **Acceptance criteria:**
  - Route `/admin/calibration` (admin-authenticated): lists `quote_comparisons` (estimate snapshot ↔ builder quote, builder, quoted_at) with the harness's hit-rate vs the internal bands (±15% new-build / ±20–25% reno — internal only, never public per HRD-009).
  - "Propose version" action: deterministic, explainable proposal — n quotes, median deviation per tier, proposed new params with a diff against the current frozen version; creates a `cost_data_versions` row in `draft` status (never mutates frozen).
  - Freeze checklist + Karan approval: publishing a version requires the checklist (fixtures updated, contract tests green, notes recorded) and an explicit approve action; unapproved publish is blocked in code. Approval is audit-logged with his identity.
  - Estimates keep pointing at their pinned version — publishing never retroactively changes old estimates (test).
  - Proposal math reuses the engine's pure functions where possible (no duplicated formulas).
- **Dependencies:** OPS-001; HRD-014 (harness + `quote_comparisons`); HRD-015 (version lifecycle); ENG-005 (calibration inputs).
- **Size:** M
- **NEEDS-KARAN:** approve each published cost-data version (standing gate).

## Assumptions log

1. Karan is the sole admin at launch; the allowlist + audit logging is the whole access-control story until a second operator exists (then: roles, via ADR).
2. Sheets sync, nudge, and unsubscribe are M4 scope (post-M1) — the consumer funnel ships without them; the 24h nudge gap (E8) is knowingly deferred, not dropped.
3. Alert thresholds in OPS-006 start at the values listed and are tuned from real traffic; the rules are config so tuning needs no deploy.
4. Ops dashboards are internal-only and carry `noindex`; they are never prerendered and never linked from public pages.
5. Financial-record retention for erasure (CAP-013) is decided by HRD-007's legal input; this epic implements the mechanics.

## Open questions

- **Q-OPS-1 (NEEDS-KARAN):** admin allowlist — which emails?
- **Q-OPS-2 (NEEDS-KARAN):** ops alert inbox address?
- **Q-OPS-3 (NEEDS-KARAN):** destination Google Sheet + service-account sharing for the sync worker?
- **Q-OPS-4:** should the builder-visible funnel subset (their own tenant only) ship with epic 05's dashboard or wait for this epic's aggregation queries? (Recommendation: ship the queries here, surface them in epic 05's dashboard when both are ready — one query implementation.)
- **Q-OPS-5:** dispute SLA — 5 business days matches ATT-006; should high-value disputes (>$X commission) escalate faster? (Recommendation: keep one SLA at launch; add tiers from experience.)
- **Q-OPS-6:** Sheets sync — one Sheet for all tenants with a tenant column, or one tab per tenant? (Recommendation: one Sheet, tenant column — simpler dedupe against the watermark.)
