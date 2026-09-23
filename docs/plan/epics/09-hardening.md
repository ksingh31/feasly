# EPIC 09 — Launch Hardening

**Owner:** TPM (implementation epics)
**Milestone coverage:** M6 (BUILD_PLAN) — launch gate
**Status:** not started — runs after M0–M5 are feature-complete; legal items
are launch blockers regardless of engineering readiness

## Goal

Make Feasly safe, legal, fast, and recoverable before first public traffic:
a threat-model-lite security review with all findings closed, privacy/terms/
CASL copy lawyer-approved, the platform agreement finalized before the first
builder signs, SEO launch checklist complete, performance budgets enforced in
CI, a verified Postgres backup/restore drill, runbooks for on-call/incidents/
dunning/breach, an accuracy-tracking harness with a calibration loop back
into cost data, and one consolidated launch checklist holding every
NEEDS-KARAN blocker.

## Non-goals

- SOC 2 / formal audit (out of scope for MVP; the threat-model-lite is the
  proportionate control).
- Penetration test by an external firm (deferred; re-evaluate at revenue).
- Multi-region / HA Postgres (single managed instance + PITR is the MVP bar).
- Rewriting features for performance (budgets gate regressions; deep
  optimization is follow-up work).

## Key decisions

1. **Threat-model-lite, not full STRIDE-everything:** one PII flow map + a
   focused review of the six highest-risk surfaces (magic-link tokens, CORS/
   postMessage embed bridge, Stripe webhooks, rate-limit abuse, Socrata proxy
   abuse, secrets handling). Findings tracked as issues; launch requires zero
   open high/critical findings.
2. **Legal review is a launch blocker, not a dev blocker:** engineering ships
   against draft copy; nothing collects an email in production until the
   lawyer signs off (HRD-007, HRD-008 — both NEEDS-KARAN).
3. **No public accuracy figure until calibrated:** per the open
   accuracy-claim decision, marketing and UI copy contain NO ± figure at
   launch (recommendation: never promise one). The ±15% new-build / ±20–25%
   reno targets are internal engineering goals tracked by the harness
   (HRD-014), not promises.
4. **PIPEDA breach posture:** runbook covers the "real risk of significant
   harm" assessment, OPC notification, and affected-individual notification —
   written before launch, not improvised during an incident.
5. **Calibration loop is human-gated:** builder quotes flow into the harness,
   the harness proposes a new `cost_data_version`, Karan approves publication
   (NEEDS-KARAN on the publish step).
6. **Performance budgets are CI gates:** Lighthouse CI on PRs, k6 smoke on
   the estimate endpoint, cold-start measurement — a PR that blows the budget
   fails.

---

## Stories (dependency order)

### HRD-001 — Threat-model-lite + PII flow map
**Description:** Produce the PII flow map (what PII exists: name, email, phone,
address, lead data; where it enters, where it's stored, where it leaves —
Postmark, Sheets sync, builder sharing) and run the focused review over the
six high-risk surfaces. Output: findings list with severity, owner, and fix
story linkage.

**Acceptance criteria:**
- Flow map diagram checked into `docs/security/pii-flows.md` covering web,
  API, MCP, Sheets sync, and builder-sharing paths.
- Findings register in `docs/security/findings.md`; every high/critical has
  a linked fix (story or direct fix) before launch sign-off.
- Review covers: magic-link token lifecycle, CORS allowlist, postMessage
  origins, Stripe webhook verification, rate-limit abuse scenarios, Socrata
  proxy abuse, secret storage.

**Dependencies:** M1–M5 feature-complete (review the real thing).
**Size:** M

### HRD-002 — Magic-link token hardening audit
**Description:** Verify the token implementation end to end: tokens stored as
hashes only (`magic_links.token_hash` — already in schema), 7-day expiry per
UX_FLOW, **multi-use bearer within the window** (decided USER_VALIDATION.md
P0-C: forwarding, partner shares, re-opens, and "Updated {date}" re-runs
require a durable link; `used_at` is recorded for analytics, NOT enforced
as single-use), no tokens in logs or error messages, resend rate-limited
(60s cooldown per UX_FLOW S7), forwarded-link bearer semantics disclosed in
the privacy page. (Embed relay codes in `embed_relay_codes` remain strictly
single-use — separate table, separate semantics.)

**Acceptance criteria:**
- Test: token accepted on 2nd/3rd use within window; expired token rejected;
  token plaintext appears nowhere in logs (grep CI check on log output).
- Resend endpoint: 2nd request within 60s → `429` with retry guidance.
- Privacy page documents bearer-token semantics (link holder sees the report).

**Dependencies:** HRD-001.
**Size:** S

### HRD-003 — CORS allowlist + postMessage origin validation
**Description:** Lock down cross-origin surfaces: API CORS allowlist =
production domain + preview domains + localhost (dev only, env-gated);
embed iframe bridge validates `event.origin` against the per-tenant allowed
embed domains; no wildcard origins in production.

**Acceptance criteria:**
- Request from a non-allowlisted origin gets no `Access-Control-Allow-Origin`
  (test with evil.example).
- postMessage handler drops messages from unregistered origins (unit test
  with forged origin).
- Tenant embed domains are admin-managed; changes audit-logged.

**Dependencies:** HRD-001; embed track (postMessage bridge exists).
**Size:** S

### HRD-004 — Stripe webhook signature verification + idempotency
**Description:** All Stripe webhooks (embed billing now, marketplace later)
verified with the signing secret; events processed idempotently by
`stripe_event_id` (dedup table); failures retry with backoff and alert after
3 failures.

**Acceptance criteria:**
- Forged-signature webhook → `400`, no state change (test).
- Same event delivered twice → processed once (dedup test).
- 3rd consecutive failure pages the on-call contact (HRD-013 wiring).

**Dependencies:** HRD-001; Stripe billing from the embed/attribution work.
**Size:** S

### HRD-005 — Rate-limit / abuse pass (platform-wide)
**Description:** Abuse review beyond the API keys (API-007 covers those):
autocomplete endpoint (debounce + per-IP throttle + min 3 chars already),
property lookup (cache-first so Socrata can't be used as an open proxy),
estimate endpoint (per-IP throttle for anonymous pre-gate calls),
magic-link resend (HRD-002), lead submit (per-IP + honeypot field).
Document the limits in `docs/security/rate-limits.md`.

**Acceptance criteria:**
- Socrata is never callable with attacker-controlled query params beyond the
  address field (code review + test with injection-style input).
- Anonymous estimate endpoint throttled to 20 req/min/IP (configurable).
- Honeypot field on lead forms; bot-flagged submissions quarantined, not
  silently dropped (visible in admin).

**Dependencies:** HRD-001.
**Size:** M

### HRD-006 — Secrets hygiene
**Description:** All secrets in Azure app settings / Key Vault references —
none in the repo, none in client bundles, none in CI logs. Enable GitHub
secret scanning + push protection; CI fails on suspected secret patterns in
diffs; document the secret inventory and rotation procedure.

**Acceptance criteria:**
- `grep` CI job finds no `sk_live`, `whsec_`, `postmark`, or private-key
  material in the repo (allowlisted test fixtures only).
- Secret scanning + push protection enabled on the repo (screenshot/checklist
  in the launch doc).
- Rotation runbook exists for: Postmark token, Stripe keys, DB password,
  Meta API key (steps + who does what).

**Dependencies:** M0 infra exists.
**Size:** S

### HRD-007 — Privacy / Terms / CASL copy finalization (LAUNCH BLOCKER)
**Description:** Finalize privacy policy, terms of service, and CASL consent
wording (gate checkbox, marketing opt-in, footer links, email footers) with a
lawyer. Covers: what we collect and why, magic-link bearer semantics, City
data attribution, no-accuracy-guarantee disclaimer, AI-narrative disclosure,
PIPEDA access/deletion request process, CASL unsubscribe mechanics, cookie/
analytics consent.

**Acceptance criteria:**
- Lawyer provides written sign-off on all three documents (filed in
  `docs/legal/`).
- Privacy + Terms pages live at footer links sitewide before first email is
  collected (UX_FLOW S12/S13 requirement).
- Consent copy in the gate, per-builder consent (MKT-007), and email footers
  matches the approved wording verbatim (diff test against approved copy).
- **NEEDS-KARAN:** engage + pay the lawyer; approve final copy.

**Dependencies:** None (parallelizable) — but blocks production email capture.
**Size:** M
**NEEDS-KARAN:** yes — lawyer engagement and copy approval.

### HRD-008 — Platform agreement legal finalization
**Description:** Lawyer-finalized builder platform agreement covering both
tracks: embed (flat vs 1% commission choice, attribution window, reporting
SLA, collection layers, dunning, access cutoff) and marketplace (1%
non-negotiable, self-reporting duty, permit cross-check consent, affiliation
disclosure for Elite entry). Must be signed before the first builder goes
live on either track.

**Acceptance criteria:**
- Signed-off agreement in `docs/legal/platform-agreement-v1.pdf`.
- E-signature flow (MKT-005) blocked until this is finalized.
- Fee terms match the settled decisions exactly (1% excl. land, 12-mo
  attribution window, 14-day reporting SLA).
- **NEEDS-KARAN:** lawyer engagement; business-terms approval.

**Dependencies:** None (parallelizable) — but blocks first builder signing.
**Size:** M
**NEEDS-KARAN:** yes — lawyer engagement and terms approval.

### HRD-009 — Disclaimer copy audit
**Description:** Sweep every user-facing surface (landing, wizard, preview,
report, PDF, API docs, MCP tool descriptions, marketing) for accuracy
guarantees, market-value claims, or unapproved ± figures. Replace with the
approved disclaimer set ("Range-based estimates…", "Dollar figures are
calculated deterministically from our cost model — not generated by AI.",
City-assessed basis labeling).

**Acceptance criteria:**
- Banned-phrase grep (`guarantee`, `±`, `accurate within`, `market value`,
  `appraisal`) returns zero hits outside explicitly allowlisted contexts
  (CI job).
- Approved disclaimer present on report, PDF, and API estimate responses.
- Copy source of truth in `docs/copy/disclaimers.md`; UI pulls from it.

**Dependencies:** HRD-007 (wording alignment).
**Size:** S

### HRD-010 — SEO launch checklist
**Description:** Custom domain live (NEEDS-KARAN purchase — feasly.com check),
sitemap.xml submitted (Search Console + Bing), robots.txt, per-page
titles/meta/OG, Schema.org (FAQ, LocalBusiness), llms.txt, canonical URLs,
custom 404, analytics behind consent mode, programmatic community pages
indexed.

**Acceptance criteria:**
- `https://feasly.com/sitemap.xml` returns 200 with all programmatic pages;
  submitted (checklist evidence).
- Sample of 10 pages: meta/OG/Schema.org validate (validator output saved).
- Analytics fires zero hits before consent (test with consent rejected).
- llms.txt served at root describing the API + MCP for agents.

**Dependencies:** M0 infra; SEO pages from earlier milestones.
**Size:** M
**NEEDS-KARAN:** yes — domain purchase.

### HRD-011 — Performance / load pass
**Description:** Enforce budgets in CI: Lighthouse CI gates on PRs (budgets
for LCP/CLS/INP per the ADR Core Web Vitals budget), k6 smoke test on
`POST /api/v1/estimates` (p95 latency + error rate thresholds), Azure
Functions cold-start measurement (documented baseline), and a DB slow-query
review (pg_stat_statements top-20, indexes where needed).

**Acceptance criteria:**
- Lighthouse CI fails PRs that regress beyond budget (config in repo).
- k6 smoke: 50 VUs for 5 min against staging → p95 < 1.5s, errors < 0.5%.
- Cold-start p95 measured and documented; if >3s, keep-warm strategy decided.
- Top-20 slow queries reviewed; missing indexes added via migration.

**Dependencies:** Staging environment (M0).
**Size:** M

### HRD-012 — Backup / restore drill (Postgres PITR)
**Description:** Verify point-in-time recovery actually works: restore the
production backup chain to a staging server at a chosen point in time,
verify data integrity (row counts, latest estimate/lead present up to the
target time), document RTO/RPO, and record the drill.

**Acceptance criteria:**
- Drill completed against a real backup (not a fresh dump): restore
  succeeds, checksums/row-counts match expectations.
- RTO/RPO documented in `docs/ops/backup.md` (targets: RPO ≤ 5 min,
  RTO ≤ 1 h — adjust to what the drill proves).
- Drill repeated at least once after any infra change to the DB.
- Backup monitoring alerts if a scheduled backup is missed.

**Dependencies:** Production Postgres (M0).
**Size:** M

### HRD-013 — Runbooks: on-call, incident, dunning disputes, breach
**Description:** `docs/ops/runbooks.md`: on-call rotation (Karan solo at
launch — escalation = page Karan), incident severity levels + comms template,
dunning dispute handling (embed + marketplace), and the PIPEDA breach
runbook: "real risk of significant harm" assessment steps, OPC notification,
affected-individual notification, timelines, and record-keeping.

**Acceptance criteria:**
- Each runbook has: trigger, first 5 actions, who decides, comms template.
- Breach runbook reviewed against PIPEDA guidance as part of HRD-007 legal
  review (lawyer confirms the notification procedure).
- Dunning runbook matches the implemented Stripe dunning steps (no doc drift
  — reviewed against code).
- On-call contact + paging path tested once (test page acknowledged).

**Dependencies:** HRD-007 (breach procedure legal review); billing flows exist.
**Size:** M

### HRD-014 — Accuracy-tracking harness
**Description:** Compare estimate snapshots against actual builder quotes:
new `quote_comparisons` table (`estimate_id` FK, `quote_low_cents`,
`quote_high_cents`, `builder_id`, `quoted_at`, `notes`); ingestion path
(admin UI entry + API for builders); dashboard showing % of new-build
estimates within ±15% and reno within ±20–25% (internal engineering goals —
never displayed publicly per HRD-009); trend over time and per tier/community.

**Acceptance criteria:**
- Quote linked to its estimate snapshot (immutable — quote never edits the
  estimate row).
- Dashboard computes hit-rate vs the internal bands; seeded fixtures show
  correct math (e.g. 8/10 within band → 80%).
- Harness excludes sandbox estimates and pre-calibration draft versions.
- Accuracy figures appear nowhere in public copy (cross-check with HRD-009
  banned-phrase CI).

**Dependencies:** Epic 02 (cost-data versions); builder quotes flowing
(embed pilot).
**Size:** M

### HRD-015 — Cost-data calibration loop
**Description:** Close the loop from harness to cost data: the harness
proposes parameter adjustments (per-tier per_sqft, bands) from aggregated
quote comparisons; a human reviews the proposal; approved proposals create a
new `cost_data_version` (draft → frozen lifecycle from Epic 02); Karan
approves publication.

**Acceptance criteria:**
- Proposal generation is deterministic and explainable (shows n quotes,
  median deviation per tier, proposed new params with diff).
- Publishing a version requires the freeze checklist + Karan approval —
  unapproved publish is blocked in code (`COST_ENGINE_ALLOW_DRAFT=false`
  analogue for publish).
- Previous version retained; estimates keep pointing at their pinned version
  (no retroactive changes — test).
- **NEEDS-KARAN:** approve each published cost-data version.

**Dependencies:** HRD-014; Epic 02 version lifecycle.
**Size:** M
**NEEDS-KARAN:** yes — version publication approval.

### HRD-016 — Consolidated launch checklist
**Description:** One document (`docs/launch-checklist.md`) consolidating every
NEEDS-KARAN blocker and go/no-go item across all epics: lawyer sign-offs
(HRD-007/008), domain purchase (HRD-010), cost Sheet calibration (M1),
Phase-2 gate (Epic 08), cost-data version approval (HRD-015), Azure/GitHub
access (M0), paid-spend approvals. Each item: owner, status, evidence link.
Launch = all boxes checked.

**Acceptance criteria:**
- Checklist auto-references the owning stories; status is updated from a
  single source (no second spreadsheet drifting).
- Go/no-go section lists the hard gates (legal, domain, backups verified,
  zero open high/critical findings).
- Karan signs the checklist (written approval) before production traffic.
- **NEEDS-KARAN:** final sign-off.

**Dependencies:** All epics (it consolidates them).
**Size:** S
**NEEDS-KARAN:** yes — final launch sign-off.

### HRD-017 — Dependency + patch policy
**Description:** Dependabot enabled (npm + GitHub Actions), weekly patch
cadence, documented policy for security advisories (patch within 7 days for
high/critical in dependencies), and a quarterly review of the Azure/Meta/
Postmark/Stripe SDK versions.

**Acceptance criteria:**
- Dependabot PRs flowing on the repo (config committed).
- Policy in `docs/ops/patching.md` with SLA per severity.
- CI runs `npm audit` (or equivalent) and fails on high/critical.

**Dependencies:** M0 repo.
**Size:** S

---

## Assumptions log

- A1: Threat-model-lite is proportionate for MVP; no external pentest before
  launch (revisit at revenue).
- A2: Single managed Postgres + PITR meets the MVP durability bar; no HA.
- A3: Karan is the solo on-call at launch; the runbook says so explicitly.
- A4: The ±15% / ±20–25% figures are internal engineering targets only —
  they never appear in public copy (HRD-009 enforces).
- A5: Legal line items (HRD-007, HRD-008) can run in parallel with
  engineering from day one — start them early, they are the long pole.
- A6: Simpler option chosen throughout: Postgres-backed rate limiting (no
  Redis), Streamable HTTP for MCP (no SSE), checklist-in-repo instead of a
  separate GRC tool.

## Open questions

- Q1: Lawyer selection — does Karan have a startup/tech lawyer, or do we
  need a referral? (Starts the HRD-007/HRD-008 clock.) **NEEDS-KARAN.**
- Q2: Is the 7-day magic-link expiry (UX_FLOW) also the right session length
  for builder/admin logins, or do builders get longer-lived sessions?
  (Recommendation: builders get 30-day sessions; magic links stay 7 days.)
- Q3: RPO/RTO targets — are RPO ≤ 5 min / RTO ≤ 1 h the right MVP bars, or
  is cheaper backup (daily, no PITR) acceptable? (Recommendation: keep PITR —
  lead PII loss is the worst failure mode.)
- Q4: Should the accuracy dashboard be visible to builders (transparency) or
  internal-only? (Recommendation: internal-only until the numbers are good
  enough to be a selling point — then revisit with Karan.)
- Q5: Incident comms — is there a status page at launch, or is email/social
  enough? (Recommendation: email + a simple `/status` page; no hosted status
  service until traffic justifies it.)
