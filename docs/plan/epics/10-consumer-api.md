# Epic 10 — Consumer API

**Status:** Draft for implementation — closes USER_VALIDATION.md §6 P0-A (the consumer API has no owning epic) and §6 P0-B (canonical endpoint registry).
**Milestone coverage:** M1 (the M1 API track that epics 03, 04, 05 assumed into existence).
**Schema:** `../SCHEMA.md` | Engine: `../COST_ENGINE.md` | UX: `../UX_FLOW.md` | Patterns: `../CODING_PATTERNS.md`

> **Planning-phase note (2026-09-23):** the conformance amendments CAP-001
> lists as acceptance criteria were already applied to the plan documents
> during reconciliation (epics 00/03/05, TECH_PLAN, CODING_PATTERNS). CAP-001's
> remaining implementation work: insert the frozen route table into
> `TECH_PLAN.md` as the single source of truth, rename the zod schemas in
> `packages/contracts`, and regenerate `openapi/v1.json`.

## Goal

Own every server-side endpoint the consumer funnel needs — lead gate, magic-link lifecycle, report fetch, what-if revisions, duplicate semantics, partner share, callback, analytics ingest, the narrative queue worker, and PIPEDA export/erasure — with one frozen route registry (CAP-001) that every other epic references instead of inventing its own names. M1 cannot function without this epic; epics 03 (WEB-009–WEB-014, WEB-017) are its clients.

## Non-goals

- Property lookup endpoints (epic 01: `PRD-002`/`PRD-003` own Socrata-backed lookup; CAP-001 only freezes their canonical names).
- The cost engine itself (epic 02: `ENG-001`–`ENG-010`); this epic calls it, never reimplements it.
- Builder embed/auth/postMessage (epic 05); builder won/lost invoice endpoints freeze in CAP-001 but their logic stays in epic 05.
- Attribution detection channels (epic 06); admin/ops surfaces (epic 11); public API/MCP (epic 07).

## Key decisions (locked)

1. **Canonical endpoint registry is frozen in CAP-001** and written into `TECH_PLAN.md` as the single route table. All contradicting route names in epics 03/05 (`/property/search`, `/estimate` singular, `/estimates/{id}/gate`, `/r/{token}` as an API path, `?token=` query params, `/callback-request`, `/report-won`, `/embed/auth/exchange`, `/api/webhooks/stripe`, `fc_`/`ek_` key prefixes) are amended to match — no new variants may be introduced.
2. **Magic links are multi-use bearers within the expiry window** (7 days proposed; NEEDS-KARAN confirms — CAP-003). `used_at` is analytics, not invalidation. This matches UX_FLOW.md cross-cutting #6 (forwarding = access), partner shares, and report re-opens. Strict single-use is reserved for embed relay codes only (epic 05).
3. **Money = integer cents end-to-end** (dollars only at display). All `*_cents` fields, Stripe amounts, and engine ranges are cents; epic 02 decision 2 / ENG-007's dollar assertions are amended accordingly (conformance note in CAP-001).
4. **Blur = placeholder DTOs.** Real figures never reach the DOM pre-verification: `POST /api/v1/estimates` returns `{ blurred: true }` placeholders for build/total; figures arrive only via a valid bearer on `GET /api/v1/reports/{token}` (CAP-004). CODING_PATTERNS.md §6's real-values-in-DOM variant is superseded.
5. **Lead status enum** is `new|contacted|quoting|won|lost` (SCHEMA.md amendment already recorded 2026-09-23); TECH_PLAN.md §1.4's won→`closed` note and §15.1 A4 are amended in CAP-001.
6. **Migration framework = dbmate**, migrations in `db/migrations/`, forward-only (TECH_PLAN.md §10.2); CAP-001 references the epic-00 `FND-006`/`FND-007` amendments rather than duplicating them.
7. **Token in path, never query string.** `GET /api/v1/magic-links/verify/{token}` — bearer tokens in query strings land in access logs (USER_VALIDATION.md §5.2). WEB-011's `verify?token=` is amended in CAP-001.
8. **What-if re-runs create new immutable `estimates` rows** (SCHEMA.md: no UPDATEs on estimates). The magic link is a re-pointable pointer: creating a revision updates `magic_links.estimate_id` to the newest snapshot. A link therefore resolves to the snapshot current when the link is used, and every link issued for a fresh share pins the snapshot it was issued for (CAP-006).
9. **No external actions in this epic.** Postmark sends and Meta API calls are the sanctioned upstreams; nothing billable or user-visible happens without the flows above.

## Stories (dependency order)

### CAP-001 — Canonical endpoint registry freeze
- **Description:** Write the canonical `/api/v1` route table (below) into `TECH_PLAN.md` as the single source of truth, and file conformance amendments against every story that names a route differently. This story is the §6 P0-B fix: after it lands, no new endpoint name may appear in any epic without amending this table first.
- **Acceptance criteria:**
  - `TECH_PLAN.md` gains a frozen route table (method, path, auth model, rate-limit tier, owning epic/story) matching the canonical registry in the task brief: `GET /api/v1/properties/autocomplete`, `GET /api/v1/properties/resolve`, `POST /api/v1/estimates`, `POST /api/v1/estimates/{id}/revisions`, `POST /api/v1/leads` (Idempotency-Key), `POST /api/v1/magic-links`, `GET /api/v1/magic-links/verify/{token}`, `POST /api/v1/magic-links/resend`, `POST /api/v1/magic-links/reissue`, `GET /api/v1/reports/{token}`, `POST /api/v1/reports/{token}/shares`, `POST /api/v1/reports/{token}/callback-requests`, `POST /api/v1/events`, `GET /api/v1/privacy/export`, `POST /api/v1/privacy/erase-requests`, `POST /api/v1/builder/leads/{id}/won`, `POST /api/v1/builder/leads/{id}/lost`, `GET /api/v1/embed/config?key=`, `POST /api/v1/embed/session`, `POST /api/v1/webhooks/stripe`.
  - Key prefixes frozen: agent API keys `feasly_live_`/`feasly_test_`; embed tenant keys `feasly_emb_`. Supersedes `ek_live_`/`fk_live_` (TECH_PLAN), `fc_` (BLD-001/BLD-006), `feasly_sk_` (CODING_PATTERNS §3).
  - Embed relay contract frozen per TECH_PLAN §2.2: URL param `feasly_rt`, exchange endpoint `POST /api/v1/embed/session {code, tenant_key}`, OTC 10-minute expiry / single-use (32-byte), session JWT 12h in-memory.
  - Rate limits frozen in the table: estimates 20/hr/IP; resend 60s per-email cooldown + 5/hr per email+IP. (Other tiers per TECH_PLAN.md §13.3; the estimates 20/hr vs HRD-005's 20/min contradiction resolves to 20/hr — HRD-005 amended.)
  - Conformance amendments filed: WEB-002 (`/property/search` → `/properties/autocomplete`, `/property?address=` → `/properties/resolve?address_key=`), WEB-007/WEB-013 (`/estimate` → `/estimates`), WEB-009 (`/leads` → `/api/v1/leads` with `estimate_id` in body), WEB-011 (`verify?token=` → `verify/{token}`; `/magic-links/reissue` kept as named), WEB-014 (`/callback-request` → `/reports/{token}/callback-requests`; partner-share → `/reports/{token}/shares`), BLD-007 (`/embed/:key/config` → `/embed/config?key=`; iframe route stays `/embed/{tenantKey}` as a page route), BLD-009 (exchange → `POST /api/v1/embed/session` per TECH_PLAN §2.2; `embed_auth_codes` → `embed_relay_codes`; OTC expiry 15-min → 10-min per §2.2; param name `feasly_rt`; 32-byte size retained), BLD-012 (`/report-won` → `/builder/leads/{id}/won`; plus `/lost`), FND-013 (`/api/webhooks/stripe` → `/api/v1/webhooks/stripe`), TECH_PLAN §1.4/§15.1-A4 (won = `won`, not `closed`), epic 02 decision 2 + ENG-007 (cents, not dollars), HRD-002/CODING_PATTERNS §2 (multi-use bearer, not single-use-on-verify).
  - `packages/contracts` zod schemas renamed to match; OpenAPI spec regenerated and committed (`openapi/v1.json`).
- **Dependencies:** none (first).
- **Size:** S (docs + renames; no new logic).

### CAP-002 — Lead gate endpoint (`POST /api/v1/leads`)
- **Description:** The S6 gate submit. Creates the user + lead + magic link + enqueues the magic-link email and the narrative job. This is the P0-J fix: the gate asks one **timeline** question, and lead scoring is derived from a value the UI actually collects. Consumed by WEB-009.
- **Acceptance criteria:**
  - Request schema (zod, in `contracts`): `{ estimate_id, email, name, phone?, timeline, casl_opt_in, tenant_key?, idempotency_key? }`; `timeline` REQUIRED ∈ `('0-3mo','3-6mo','6-12mo','12+mo','exploring')`; email validated; phone optional.
  - Server transaction: upsert `users` (citext email; name/phone updated on re-submit), insert `leads` with `timeline`, `lead_score` derived `0-3mo→hot`, `3-6mo→warm`, else `cold`; `consent_ts=now()`; `marketing_consent=casl_opt_in` on the lead; `tenant_id` resolved from `tenant_key` when present (NULL = feasly_direct); `source='web'` (or `'embed'` when `tenant_key` present — records embed provenance).
  - Duplicate handling per CAP-006 (same email + address_key within 90 days → update existing lead, new estimate snapshot).
  - Idempotency: `Idempotency-Key` header (UUID v4) honored per CODING_PATTERNS §3 — same key + same payload → original response replayed with `Idempotent-Replayed: true`; different payload → 409 `IDEMPOTENCY_CONFLICT`.
  - On success: magic link issued (multi-use bearer, hashed at rest), Postmark magic-link email enqueued, narrative job enqueued; response `{ ok: true }` (200) — never reveals whether the email was previously known.
  - Rate limit: gate 10/hr/IP (TECH_PLAN §13.3). Honeypot field per HRD-005; bot-flagged submissions quarantined, visible to ops (OPS-002).
  - Migration note (prerequisite, owned by epic 00 `FND-007` amendment): `leads.phone` must become nullable (E7 — phone is optional at the gate); `leads.timeline` stays NOT NULL.
- **Dependencies:** CAP-001; CAP-003 (magic-link issuance); CAP-011 (narrative enqueue); CAP-006 (dedupe rule).
- **Size:** M
- **NEEDS-KARAN:** Q2 — gate name field required (recommended) vs optional (affects `name NOT NULL` on leads).

### CAP-003 — Magic-link lifecycle (send / verify / resend / reissue)
- **Description:** The single auth primitive for consumers. Multi-use bearer tokens; issuance, verification, throttled resend, and re-issue for expired links. Consumed by WEB-010/WEB-011 and the embed relay fallback.
- **Acceptance criteria:**
  - `POST /api/v1/magic-links` (send): `{ email, estimate_id }` → issues a new bearer for that user+estimate; always 200 with identical copy whether or not the email exists (enumeration resistance). Revokes prior unexpired links for the same `(user_id, estimate_id)` (one live link per estimate per user).
  - `GET /api/v1/magic-links/verify/{token}` (token in PATH): SHA-256 hash compare, constant-time; valid → `{ valid: true, estimate_id, expires_at, expires_in_days }` and sets `used_at` on first redemption (analytics only — bearer stays valid to `expires_at`); unknown → 401 `LINK_INVALID`; expired/revoked → 410 `LINK_EXPIRED` with the re-issue copy. No oracle distinguishing nonexistent vs expired (same timing, generic copy).
  - `POST /api/v1/magic-links/resend` `{ email, estimate_id }`: 60s per-email cooldown + 5/hr per (email+IP); always 200; new link revokes the old one for that `(user_id, estimate_id)`.
  - `POST /api/v1/magic-links/reissue` `{ email, estimate_id }`: for expired links — same rate limits as resend; issues a fresh link (the expired row is not revived).
  - Token: 32 random bytes, base64url, 256-bit; only the hash stored; 7-day expiry (**NEEDS-KARAN** confirms window — default 7 days until answered).
  - Raw tokens never appear in logs, error messages, or App Insights (CI grep check).
- **Dependencies:** CAP-001.
- **Size:** M
- **NEEDS-KARAN:** magic-link expiry window — 7 days OK? (TECH_PLAN §14.1 / UX Q3; default 7 days).

### CAP-004 — Report fetch by token (`GET /api/v1/reports/{token}`)
- **Description:** The S8 data source. Bearer-gated; returns placeholder DTOs pre-verification and full figures only with a valid bearer. Never prerendered, `noindex`. Consumed by WEB-011/WEB-012; the narrative portion depends on CAP-011.
- **Acceptance criteria:**
  - Bearer valid → 200 with the full report DTO: estimate snapshot (figures in cents), breakdown `rows[]`, `assumptions[]`, `cost_data_version`, assessed-value context, `narrative` (or `{ narrative_status: 'pending' }` if the queue hasn't finished), `snapshot_count`, `updated_at` ("Updated {date}" semantics), disclaimer strings.
  - Pre-verification (no/invalid bearer) → 401 `LINK_INVALID` / 410 `LINK_EXPIRED` — **never** a partial-figures payload. The only pre-gate figures surface is the blurred placeholder DTO from `POST /api/v1/estimates` (`{ blurred: true }`, no numbers in the DOM — decision 4).
  - Link resolution per CAP-006: the report renders the estimate the link's `estimate_id` currently points at; `snapshot_count > 1` → header shows "Updated {date}".
  - Narrative pending → figures render immediately with the "narrative unavailable — retry" state (never infinite poll; CAP-011 defines the poll budget).
  - Headers: `X-Robots-Tag: noindex, nofollow`; route absent from sitemap (asserted by epic 04's sitemap test); rate limit 120/hr/IP (bearer-gated anyway).
  - Secret-leak assertion: the serialized response contains no `per_sqft`, `margin`, or param-table keys (reuses the cost-engine secret-leak test against the report serializer).
- **Dependencies:** CAP-001, CAP-003, CAP-006 (resolution rule); CAP-011 (narrative).
- **Size:** S

### CAP-005 — What-if revisions (`POST /api/v1/estimates/{id}/revisions`)
- **Description:** Tier toggle / sqft re-run from the report. Each re-run is a new immutable estimate row; the caller's magic link is re-pointed to it. Consumed by WEB-013.
- **Acceptance criteria:**
  - Request (bearer-authenticated via the report's magic-link token or the embed session JWT): `{ tier?, sqft?, garage?, basement? }` — at least one changed field required; address and project_type immutable (changing address = new estimate via `POST /api/v1/estimates`, not a revision).
  - Server: loads the active `cost_data_version` for the city, runs `packages/cost-engine`, inserts a NEW `estimates` row, updates the calling `magic_links.estimate_id` to the new row (link re-pointed; old snapshots retained for history), returns `{ estimate_id, figures, snapshot_count, updated_at }`.
  - Narrative regenerates only when the total range shifts >5% (avoids Meta API spend on trivial nudges — epic 03 assumption 4); otherwise the prior narrative is carried forward.
  - Debounce/cancel handled client-side (WEB-013); server enforces bearer rate limit 120/hr/IP and rejects concurrent in-flight revisions for the same link with 409 (last-write-wins needs a single writer — server serializes per `magic_link_id`).
  - Every revision writes an `audit_log`-adjacent record (estimate id, inputs, version, actor) — estimates stay the immutable audit trail.
- **Dependencies:** CAP-001, CAP-004; epic 02 engine.
- **Size:** M

### CAP-006 — Duplicate-estimate semantics
- **Description:** The E9/P1-6 fix: what "same email + same address" means, which snapshot a link resolves to, and what the dedupe update actually does. Mostly a decision with small logic.
- **Acceptance criteria:**
  - New inputs for a known email+address_key always create a NEW `estimates` snapshot (never overwrite); report header shows "Updated {date}" when `snapshot_count > 1`.
  - Link resolution rule (locked): a magic link renders the snapshot its `estimate_id` points to **at fetch time**. Fresh links (gate, reissue, share) pin the latest snapshot; what-if revisions re-point the calling link (CAP-005). Partner shares pin the snapshot current at share time (CAP-008).
  - Dedupe rule: same email + same `address_key` within 90 days → UPDATE the existing lead row (set `estimate_id` to the newest snapshot, recompute `lead_score` from the new timeline, refresh `notes` with the re-run summary) instead of creating a duplicate lead. Lead `status` is not reset (a `contacted` lead stays `contacted`); no new magic-link email is sent unless the user requests reissue. The 90-day rule itself is **NEEDS-KARAN** (TECH_PLAN §14.10) — implemented as config, flippable.
  - Aligned with ATT-002's attribution dedupe identity (tenant + email/phone/address within 90d anchors the 12-month window to the FIRST handoff) — this story's lead-row update must not move the attribution anchor.
  - "Estimate another address" (UX S8 secondary) is a new estimate + same-user lead (no dedupe across addresses); see CAP-007 for the recognized-email shortcut.
- **Dependencies:** CAP-001, CAP-002.
- **Size:** S
- **NEEDS-KARAN:** 90-day dedupe rule — update-in-place OK? (TECH_PLAN §14.10.)

### CAP-007 — Recognized-email shortcut
- **Description:** The USER_VALIDATION §4-gap-4 fix: an already-verified user running "estimate another address" should not hit the full gate again — pure friction.
- **Acceptance criteria:**
  - `POST /api/v1/leads` with an email whose most recent magic link has `used_at` (email verified) within the last 30 days → the API issues a fresh magic link immediately and returns `{ ok: true, recognized: true }`; the client skips the gate modal and shows a one-click "Send report to {email}" confirmation instead (WEB-009 implements the UI branch).
  - Beyond 30 days since last verification → normal gate flow (re-verification required).
  - The shortcut applies per email, not per device — a verified email on a new device still shortcuts (the proof is email ownership, which the fresh link re-confirms).
  - Tenant-aware: the recognized shortcut works in embeds too (`tenant_key` carried through); the lead is still tenant-attributed.
  - The gate modal remains available ("use a different email") — the shortcut is a fast path, not the only path.
- **Dependencies:** CAP-002, CAP-003.
- **Size:** S

### CAP-008 — Partner share (`POST /api/v1/reports/{token}/shares`)
- **Description:** "Email to partner" (S10). Each share mints a fresh bearer so the consumer's link is never the one forwarded. Consumed by WEB-014. The E19 abuse-control gap is closed here.
- **Acceptance criteria:**
  - Request (bearer-authenticated): `{ partner_email }` → validates email format; creates a NEW `magic_links` row pinned to the current snapshot + a `report_shares` row (estimate, user, partner_email, magic_link_id); enqueues the Postmark share email; returns `{ ok: true }`.
  - Abuse limits: max 5 shares per estimate per day; 10/hr per bearer; partner email must differ from the owner's email; share emails carry the same enumeration-resistant copy as magic-link sends.
  - The share link is a standard multi-use bearer (7-day window); its `estimate_id` pins the snapshot current at share time and is NOT re-pointed by later what-if revisions on the owner's link.
  - Partner opens the link → CAP-004 renders the full report (figures + narrative); partner cannot re-share (shares endpoint requires the owner bearer — partner links get 403 on `/shares`).
- **Dependencies:** CAP-001, CAP-004.
- **Size:** S

### CAP-009 — Callback request (`POST /api/v1/reports/{token}/callback-requests`)
- **Description:** S9 inline panel backend. Emails the Feasly team; the client never sees the destination. Consumed by WEB-014.
- **Acceptance criteria:**
  - Request (bearer-authenticated): `{ name?, phone (required), window: 'morning'|'afternoon'|'evening' }`; `name`/`phone` prefill from the gate's `users` row when present (P2 gap closed: phone prefills from the gate); missing phone → 400 inline error.
  - Server enqueues a Postmark email to the Feasly team inbox with name, phone, window, estimate summary link (internal), lead score; response `{ ok: true, window }` → client renders "Thanks — we'll call you {window}."
  - Idempotency-Key supported (double-submit safe).
  - **NEEDS-KARAN:** destination inbox address (e.g. `team@feasly.com`).
- **Dependencies:** CAP-001.
- **Size:** S
- **NEEDS-KARAN:** Feasly team inbox for callback emails (UX Q5).

### CAP-010 — Analytics events ingest (`POST /api/v1/events`)
- **Description:** First-party, consent-gated analytics. No third-party trackers pre-consent (USER_VALIDATION §4-gap-9). Consumed by WEB-017; feeds the funnel dashboards (OPS-008).
- **Acceptance criteria:**
  - Request: `{ event, route, ts, consent_ts }` — `event` ∈ allowlist (`step_view`, `gate_view`, `gate_convert`, `report_open`, `tier_toggle`, `callback_request`, `partner_share`, `pdf_download`, `embed_loaded`); `consent_ts` REQUIRED — missing or future-dated → 400 `CONSENT_REQUIRED` (no events before the banner is acknowledged).
  - Payload schema is an allowlist: `{ event, route, ts }` only — email, address, or figures in the payload → 400 `VALIDATION_ERROR` (PII can never enter the events table; asserted by a schema test).
  - No cookies set, no fingerprinting; per-IP rate limit 300/min; events stored append-only for OPS-008 funnel queries.
  - The consent banner UI itself is owned by epic 03 (P1-8); this story owns the server-side gate.
- **Dependencies:** CAP-001.
- **Size:** S

### CAP-011 — Narrative queue worker
- **Description:** The async Meta-API narrative step (TECH_PLAN §2.1-step-5). Figures never wait for the LLM; the report renders with a bounded "narrative unavailable — retry" state on failure (the §5.2 narrative-failure-UX gap).
- **Acceptance criteria:**
  - Queue trigger `narrative-requests`: loads the estimate outputs + `assumptions[]` + City facts; calls Meta API via the provider abstraction (`lib/llm.ts`), prompt from the versioned template (`apps/api/src/prompts/v1.ts`); writes `estimates.narrative`; logs `prompt_version` + `cost_data_version` for audit.
  - Banned-content guards: prompt builder takes engine output read-only (a test asserts the prompt contains no money arithmetic); banned-phrase lint covers `$729K`-style figures (extends ENG-010's regex gap); narrative text is stored verbatim, never edited.
  - SLA target <60s; failure → retry with backoff; after 3 consecutive failures alert ops (OPS-006); the report shows figures + "Narrative unavailable — retry" with a working retry button that re-enqueues (never an infinite poll — client polls at most 12 times / 60s, then settles on the error state).
  - Required footer appended verbatim: "Dollar figures are calculated deterministically from our cost model — not generated by AI."
- **Dependencies:** CAP-001; epic 02 engine outputs.
- **Size:** M

### CAP-012 — PIPEDA export (`GET /api/v1/privacy/export`)
- **Description:** Self-serve data export (E22 — launch-blocker-adjacent: PIPEDA access rights apply from the first email collected). Magic-link authenticated.
- **Acceptance criteria:**
  - Bearer-authenticated (the caller's own magic link): returns the per-user data inventory as JSON — `users` row, `leads` (with tenant attribution + scores), `estimates` snapshots (inputs/outputs/version), `magic_links` metadata (created/expires/used — hashes only, no tokens), `report_shares`, `callback_requests`, consent timestamps.
  - Scoped strictly to the authenticated `user_id`; cross-user access → 403; export request itself is audit-logged.
  - Machine-readable JSON download; rate-limited 5/hr per user.
  - Copy (what's included, retention notes) reviewed under HRD-007.
- **Dependencies:** CAP-001, CAP-003; HRD-007 (copy/legal framing).
- **Size:** M

### CAP-013 — PIPEDA erasure (`POST /api/v1/privacy/erase-requests`)
- **Description:** Self-serve erasure with explicit consequences and financial-record retention. Human-confirmed before execution.
- **Acceptance criteria:**
  - Request (bearer-authenticated) creates an `erasure_requests` row (`user_id`, `status: 'requested'`) and returns the consequences statement: report links stop working, shared links are revoked, anonymized aggregates remain.
  - Execution (ops-confirmed via OPS-002 action): anonymize `users` (email → one-way hash, name/phone → NULL), revoke all `magic_links` for the user, anonymize `leads` rows (PII nulled; score/status/timestamps retained for funnel integrity).
  - Financial records are RETAINED per legal input via HRD-007: `commission_invoices`, `attribution_events`, and `audit_log` rows are never deleted — the linked lead/user references are anonymized in place, the financial facts survive (E22 cascade rule).
  - Leads tied to open disputes or in-review invoices block erasure until resolved (returned as 409 with the reason).
  - Status transitions (`requested → confirmed → executed`) are audit-logged; the user is emailed confirmation at execution.
  - **NEEDS-KARAN (via HRD-007):** legal sign-off on retention periods and the consequences copy.
- **Dependencies:** CAP-001, CAP-003; HRD-007 (retention rules).
- **Size:** M
- **NEEDS-KARAN:** lawyer confirms financial-record retention rules + erasure copy (HRD-007).

## Assumptions log

1. The 30-day recognized-email window (CAP-007) is a product call made here; simplest option wins — revisit via ADR if abuse appears.
2. `POST /api/v1/magic-links` (explicit send) is distinct from the gate's implicit issuance (CAP-002) and from resend/reissue; clients use the right one for the right intent.
3. Server-side serialization of money-adjacent fields is covered by the secret-leak test wherever a new serializer is added.
4. The consent banner UI (epic 03, P1-8) is the only client of the `consent_ts` gate in CAP-010; no other endpoint requires consent state.
5. Narrative failures are never silent: ops alerting (OPS-006) + user-facing retry state.

## Open questions

- **Q-CAP-1 (NEEDS-KARAN):** magic-link expiry window — 7 days OK? (Carried from TECH_PLAN §14.1.)
- **Q-CAP-2 (NEEDS-KARAN):** 90-day dedupe rule — update-in-place OK?
- **Q-CAP-3 (NEEDS-KARAN):** gate name field — required or optional?
- **Q-CAP-4 (NEEDS-KARAN):** callback destination inbox address?
- **Q-CAP-5:** should `GET /api/v1/estimates/{id}` (direct id fetch, referenced by WEB-012) exist as an admin/bearer-scoped endpoint, or is token-based report fetch the only read path? (Recommendation: token-only for consumers; admin reads go through OPS-002's scoped API. Decide in epic 00's API-surface review.)
- **Q-CAP-6:** estimate-history view (user sees/reverts earlier snapshots — USER_VALIDATION P2) — M1 or later? (Recommendation: later; snapshots are retained, UI deferred.)
