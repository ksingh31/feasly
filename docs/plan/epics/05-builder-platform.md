# Epic 05 — Builder Platform (SaaS embed, Model B first)

**Status:** Draft for implementation — blocked on platform-agreement legal review (NEEDS-KARAN) before first builder activation.
**Milestone target:** M4/M5-adjacent commercial track; Elite Craft Builders is pilot tenant #1.
**ADR:** `../../adr/ADR-001-architecture.md` | Schema: `../SCHEMA.md`

## Goal

Let builders self-serve onboard, choose a plan (flat monthly OR 1% commission), put down a card-on-file, paste one snippet onto their website, and run a white-labeled Feasly estimator inside a sandboxed iframe — while Feasly captures every lead, routes it to the builder's pipeline dashboard, and invoices commission on wins.

## Non-goals

- Marketplace lead allocation / match scores (deferred to Model A; this epic is embed-only on builders' own sites).
- Full white-label (logo/name/accent + retained "Powered by Feasly" badge only; full white-label is a TBD paid tier — NOT v1).
- Builder self-serve cost-data editing (cost params stay Feasly-operated).
- Chargebacks/refund tooling beyond Stripe's built-in dispute handling.

## Key decisions (locked)

1. **Model B (SaaS embed) FIRST, Model A marketplace LATER.** Everything here serves builders embedding on their own sites.
2. **KYC-lite: no formal identity verification.** Signup = business name, contact name, email, phone, website/domain. Verification = email ownership + domain sanity check + manual ops approval of the first N tenants (Elite first). Decision: simpler than document KYC; a builder embedding our estimator and paying us is low fraud risk. Logged in assumptions.
3. **Card-on-file is REQUIRED before the embed activates** — on BOTH plans (flat and commission). No card, no live embed key. This is the collection backbone.
4. **Billing = Stripe.** Flat plan → Stripe Subscription (Product/Price, recurring monthly). Commission → Stripe Customer + saved PaymentMethod (SetupIntent), charged via off-session PaymentIntent when invoices finalize. Internal `commission_invoices` table is the record; Stripe is the money rail.
5. **Commission flow: win → draft invoice → 7-day review → auto-charge.** Builder marks lead won and enters contract value → system drafts a 1% invoice (excl. land) → 7-day review window (builder can dispute with evidence) → auto-charge to card-on-file. Failure → dunning state machine.
6. **Iframe route:** `/embed/{tenantKey}` (e.g. `https://embed.feasly.com/embed/fc_a1b2c3…`). Sandboxed iframe (`sandbox="allow-scripts allow-same-origin allow-forms"`), auto-resize via postMessage, strict origin validation both sides.
7. **Magic-link token-relay (no third-party-cookie dependence):** one-time code lands in the *builder page* URL → loader snippet hands it to the iframe via postMessage → iframe exchanges it with the Feasly API → session is established in the iframe's partitioned storage. Full handshake spec in BLD-008.
8. **Lead status enum unified:** `new → contacted → quoting → won / lost`. This extends SCHEMA.md's `leads.status` CHECK (which currently lists `qualified`/`closed`); the schema migration in this epic supersedes it — one enum for consumer leads and builder pipeline.
9. **Dunning timelines:** Day 0–7 grace (auto-retry failed charge), Day 8–21 degraded embed ("contact builder directly" fallback; lead-gen pauses but page never breaks), Day 22+ suspension (embed offline; reactivation on successful payment). See BLD-013.

---

## Stories (dependency order)

### BLD-001 — Builder signup + tenant provisioning
- **Description:** Self-serve signup creates a Feasly account AND a tenant row per SCHEMA.md (`tenants` table). This is the entry point for every builder; Elite Craft is provisioned through the same flow (manually assisted) so the path is dogfooded from day one.
- **Acceptance criteria:**
  - POST `/api/v1/builder/signup` accepts `{ business_name, contact_name, email, phone, website, city_slug }`; validates email + phone format; rejects duplicates (same email or same domain+name → 409 with "contact us" message).
  - Creates `users` row (role `builder_admin`), `tenants` row with `status='pending'`, unique `slug` (kebab from business name, collision-suffixed), and a unique `embed_key` (`fc_` + 24 URL-safe chars, stored plaintext in DB, shown once).
  - Sends verification email (Postmark) with 24h-expiry link → GET `/api/v1/builder/verify/{token}` flips email_verified; unverified tenants cannot proceed to plan choice.
  - Tenant starts `active=false`, `status='pending'`; a Feasly ops alert (email) fires on each signup.
  - No formal KYC documents collected (per decision 2).
- **Dependencies:** epic 01 (Postmark templates, users/magic-link infra) for email sending.
- **Size:** M

### BLD-002 — Platform agreement clickwrap (v1)
- **Description:** Builder must accept the platform agreement (commission terms, reporting SLA, prior-relationship rules, data handling) before plan choice. Clickwrap acceptance is recorded immutably.
- **Acceptance criteria:**
  - Legal text rendered from a versioned source (`platform_agreements` table: `id, version, text_md, effective_from`); UI shows version + effective date.
  - POST `/api/v1/builder/agreement/accept` with `{ agreement_version }` records `{ tenant_id, user_id, version, ip, user_agent, accepted_at }` in `agreement_acceptances`; immutable (no update path).
  - Embed key is NOT issued / stays inactive until an acceptance row exists for the current agreement version; re-acceptance required if version changes.
  - **[NEEDS-KARAN] Lawyer drafts the actual agreement text before any builder (incl. Elite) can be activated — launch blocker.** Engineering ships the clickwrap mechanism with clearly-marked placeholder text and a version gate.
- **Dependencies:** BLD-001.
- **Size:** S (mechanism); legal text is the blocker.

### BLD-003 — Plan-choice UI with breakeven nudge
- **Description:** Builder picks flat monthly vs 1% commission. UI shows a computed breakeven nudge so the choice is informed, not guessed.
- **Acceptance criteria:**
  - GET `/api/v1/builder/plan-options` returns `{ flat_price_cents, commission_rate_bps: 100, avg_contract_default_cents }`.
  - UI helper: "Switch to flat when you close **>N deals/mo**", where `N = ceil(flat_price / (avg_contract_value × 1%))`. avg_contract_value = builder's entered typical contract value if provided, else Calgary default (e.g. $750,000 — configurable, Feasly-operated).
  - POST `/api/v1/builder/plan` with `{ plan: 'flat' | 'commission' }` persists to `tenants.plan`; plan can be changed later (see BLD-014).
  - Flat price is a Feasly-operated config value (placeholder until Karan sets it — see open questions).
- **Dependencies:** BLD-002.
- **Size:** S

### BLD-004 — Stripe Customer + mandatory card-on-file (both plans)
- **Description:** No card, no live embed. Builder adds a card via Stripe; Feasly stores only Stripe references, never PANs.
- **Acceptance criteria:**
  - On plan selection, POST `/api/v1/builder/billing/setup-intent` creates a Stripe Customer (`tenants.stripe_customer_id`) + SetupIntent; returns `client_secret`.
  - Frontend uses Stripe.js (Elements) to collect the card; on success, webhook `setup_intent.succeeded` → store `stripe_payment_method_id` on tenant, set as customer's default payment method (`invoice_settings.default_payment_method`).
  - GET `/api/v1/builder/billing/status` returns `{ has_card: bool, plan }`; embed activation (BLD-006) and dashboard access are gated on `has_card=true`.
  - Card replace flow reuses the same endpoint; old method detached only after new one succeeds (never a gap).
  - Test mode: Stripe test cards accepted; live mode requires real card.
- **Dependencies:** BLD-003; Stripe account + webhook endpoint (epic 01 infra).
- **Size:** M

### BLD-005 — Flat-plan subscription provisioning
- **Description:** Flat-plan builders get a real Stripe Subscription billed monthly.
- **Acceptance criteria:**
  - After card-on-file + plan='flat', POST `/api/v1/builder/billing/subscribe` creates Stripe Subscription from the configured Price (metadata `{ tenant_id }`); stores row in `subscriptions` (`tenant_id, stripe_subscription_id, plan='flat', status, current_period_start/end`).
  - Webhooks `customer.subscription.updated/deleted` and `invoice.payment_failed` update `subscriptions.status`; payment failures feed the dunning machine (BLD-013).
  - Builder billing page shows next invoice date + amount; "cancel" downgrades per BLD-014 rules (no mid-cycle refund — credit toward commission invoices instead; logged in assumptions).
- **Dependencies:** BLD-004.
- **Size:** S

### BLD-006 — Embed snippet generator + install docs
- **Description:** Builder copies one snippet, pastes it on their site, done. Snippet carries the tenant key and handles iframe injection, resize, and origin config.
- **Acceptance criteria:**
  - Dashboard page "Install" shows the snippet (copy button):
    ```html
    <script src="https://embed.feasly.com/loader.js"
            data-feasly-key="fc_<tenantkey>"
            data-feasly-theme="auto"></script>
    ```
  - `loader.js` (served with long cache headers, versioned URL) validates `data-feasly-key`, injects `<iframe src="https://embed.feasly.com/embed/{key}" sandbox="allow-scripts allow-same-origin allow-forms" allow="clipboard-write">` into the script's parent element, and listens for `feasly:resize` to set iframe height.
  - Install docs (in-dashboard + `docs.feasly.com/embed`): paste placement (WordPress/Custom/Elementor notes), required `allow` attributes, CSP note (`frame-src https://embed.feasly.com`), troubleshooting (key invalid, domain mismatch).
  - Snippet page is only unlocked when `has_card=true` AND agreement accepted; before that it shows the remaining checklist steps.
- **Dependencies:** BLD-004, BLD-007 (iframe route must exist to point at).
- **Size:** M

### BLD-007 — Iframe app route `/embed/{tenantKey}` with theme handshake
- **Description:** The estimator rendered inside the builder's site, themed with the builder's brand, served from Feasly's embed domain.
- **Acceptance criteria:**
  - Angular route `/embed/:tenantKey` (prerender-excluded, client-rendered) resolves tenant by `embed_key`; invalid/revoked key → branded "Estimator unavailable — contact the builder" page (never a blank iframe, never a stack trace).
  - Theme handshake: on load, iframe fetches GET `/api/v1/embed/config?key=` → `{ business_name, logo_url, accent_color, allowed_origins }` from `tenants.branding` (jsonb); applies logo/name/accent; falls back to Feasly defaults if branding unset.
  - Wizard inside iframe = M1 flow (S1–S8) adapted: same cost engine, same gating rules, same UX copy; lead `tenant_id` set from the key; `source='web'`.
  - "Powered by Feasly" badge rendered bottom-right, non-removable in v1 (no config flag to hide; CSS `!important` on badge positioning, server-side check that badge HTML is present in the embed template — BLD-010 tests it).
  - Inactive tenant (`active=false`, suspended, or no card) → iframe serves the degraded "contact builder directly" fallback card (same component used by dunning, BLD-013).
- **Dependencies:** BLD-001 (tenant), BLD-009 (branding config UI can come later; defaults first); M1 wizard components.
- **Size:** L

### BLD-008 — postMessage bridge (lead events, resize, origin validation)
- **Description:** The bridge that lets the builder's page (and their CRM/analytics) react to what happens inside the iframe. **Canonical contract = TECH_PLAN §4.3** (decided USER_VALIDATION.md P1-3; this story's older `feasly:*` names and PII-carrying payloads are superseded).
- **Acceptance criteria:**
  - Message types (all namespaced `FEASLY_`, per TECH_PLAN §4.3):
    - `FEASLY_READY` / `FEASLY_INIT` (boot + theme handshake), `FEASLY_RESIZE {height}` (ResizeObserver, debounced 100ms), `FEASLY_RELAY_TOKEN {code}` (parent→iframe only, once per boot), `FEASLY_AUTH_OK {estimateId, leadScore}`, `FEASLY_AUTH_ERROR {code:'expired'|'invalid'|'used'}`, `FEASLY_LEAD_EVENT {event:'gate_submitted', estimateId, leadScore}`, `FEASLY_THEME_APPLIED {}`.
  - **No PII crosses postMessage, ever.** No name/email/phone/timeline in any payload — the builder fetches lead details via the authenticated dashboard API. (This replaces the old `feasly:lead.created` PII payload.)
  - Origin validation: iframe only accepts messages with `event.origin` in `tenants.allowed_origins`; `loader.js` only accepts `FEASLY_*` from `https://embed.feasly.com`. Any other origin → dropped + console warning (no error toast to end users).
  - Docs include a copy-paste JS listener example for pushing `FEASLY_LEAD_EVENT` into a CRM webhook / GA4 `dataLayer` (opaque IDs only — CRM enrichment happens server-side).
  - E2E test: fake parent page asserting `FEASLY_LEAD_EVENT` payload shape (no PII keys present — assertion enumerates keys) and that a spoofed origin's `FEASLY_RELAY_TOKEN` is ignored.
- **Dependencies:** BLD-006, BLD-007.
- **Size:** M

### BLD-009 — Magic-link token-relay inside the iframe
- **Description:** The fiddliest piece (per context): magic-link auth must work inside a sandboxed iframe where third-party cookies are unavailable. The one-time code travels via the builder's own page URL, never relying on cross-site cookies. **Session strategy = TECH_PLAN §2.2** (decided USER_VALIDATION.md P1-3): in-memory JWT in the iframe, no cookies, no localStorage, no `allow-same-origin` in the sandbox. The magic link itself is the durable credential (re-click re-establishes the session).
- **Handshake spec (locked, per TECH_PLAN §2.2):**
  1. Feasly sends the magic-link email; the link points to the **builder's page** (configurable `report_url_template` on tenant, e.g. `https://elitebuilder.com/estimate?feasly_rt={code}`), NOT to feasly.com.
  2. `{code}` is a single-use, **10-minute-expiry**, 32-byte random token. Stored as `embed_relay_codes` (`id, tenant_id, user_id, estimate_id, code_hash, expires_at, used_at` — canonical table name; supersedes the older `embed_auth_codes`); plaintext code only ever in the email URL.
  3. Builder page loads `loader.js` (already installed). Loader reads `feasly_rt` from its own URL query string, **stores it in builder-origin `sessionStorage`**, removes it from the visible URL (`history.replaceState`), and posts `FEASLY_RELAY_TOKEN {code}` to the iframe (targetOrigin = embed.feasly.com; iframe accepts it once per boot).
  4. Iframe calls `POST /api/v1/embed/session {code, tenant_key}` → server validates hash/expiry/single-use + tenant match (marks `used_at` in the same transaction) → returns a **12h in-memory session JWT** (Angular service; never persisted). **No `Set-Cookie`, no localStorage** in the iframe — privacy-strict by design.
  5. Iframe loads the full report (S8 equivalent) and posts `FEASLY_AUTH_OK {estimateId, leadScore}` (no PII) to the parent. If the iframe reloads after exchange, the loader re-posts the OTC from `sessionStorage` (covers pre-exchange reloads); if the code is consumed/expired → `FEASLY_AUTH_ERROR` → iframe shows a "session expired" state with one-tap "Email me a fresh link" (re-issue flow — no dead end, no console jargon).
- **Acceptance criteria:**
  - Exchange endpoint enforces single-use atomically (row-lock / `UPDATE … WHERE used_at IS NULL`); replay of a used code → 410 `used` with re-issue affordance.
  - Expired code → 410 with resend affordance (resend issues a NEW code, rate-limited 60s like M1 S7).
  - Works with third-party cookies fully blocked (test with browser profile blocking 3P cookies): nothing in the design depends on them.
  - If the builder has not configured `report_url_template`, magic links fall back to the Feasly-hosted report URL (consumer flow, M1) — embed lead still attributed via `tenant_id` on the lead row.
  - Audit: every exchange attempt (success/fail) logged with `tenant_id, code_id, ip, result`.
- **Dependencies:** BLD-007, BLD-008; epic 01 magic-link email infra.
- **Size:** L

### BLD-010 — Tenant branding config UI
- **Description:** Builder customizes how the embed looks on their site: logo, business name display, accent color, fallback contact info for the degraded card.
- **Acceptance criteria:**
  - Dashboard → Settings → Branding: logo upload (PNG/SVG, ≤2MB, stored in Azure Blob, served via CDN URL), display name, accent color picker (validated hex; contrast-checked against white — warn if < 4.5:1), fallback phone/email for the "contact builder directly" card.
  - Saved to `tenants.branding` jsonb `{ logo_url, display_name, accent_color, fallback_phone, fallback_email }`; live preview iframe on the settings page.
  - "Powered by Feasly" badge has NO toggle in v1 — acceptance test asserts the badge node exists in the embed DOM for all branding combinations.
- **Dependencies:** BLD-001; Azure Blob storage (epic 01).
- **Size:** S

### BLD-011 — Lead pipeline dashboard
- **Description:** Builder's working view of every Feasly-routed lead: new → contacted → quoting → won/lost, with detail panel and notes.
- **Acceptance criteria:**
  - Angular route `/builder/leads` (builder-authenticated; tenant-scoped: every query filtered by `tenant_id` from the session — no cross-tenant leakage; test asserts tenant B cannot read tenant A's lead).
  - Kanban or table with columns `new / contacted / quoting / won / lost`; drag or dropdown to move; filters: lead_score (hot/warm/cold), date range, project_type, search by name/email/address.
  - Detail panel: estimate summary (address, sqft, tier, ranges), timeline, consent timestamp, full notes thread (append-only `lead_notes`: `id, lead_id, author_user_id, body, created_at`), status-change history (`lead_status_history`: `id, lead_id, from_status, to_status, changed_by, changed_at`).
  - Status change to `won` triggers the won-reporting flow (BLD-012) — dashboard prompts for contract value immediately.
  - CSV export of filtered leads.
- **Dependencies:** BLD-001; M4 lead model (shared tables).
- **Size:** M

### BLD-012 — Won/lost reporting → draft commission invoice → auto-charge
- **Description:** The money story: builder reports a win with the contract value → Feasly drafts a 1% invoice → 7-day review → auto-charge to the card on file.
- **Acceptance criteria:**
  - Marking `won` requires `contract_value_cents` (gross construction contract value, land excluded — UI labels this explicitly with a helper: "Enter the construction contract value only — exclude land/lot cost") and `contract_signed_date`.
  - POST `/api/v1/builder/leads/{id}/won` creates `commission_invoices` row: `status='draft'`, `commission_cents = round(contract_value_cents × 0.01)`, `review_due_at = now() + 7 days`, line items jsonb `[{ description: 'Feasly commission 1% — {address}', amount_cents }]`. Builder sees the draft immediately in Billing → Invoices with countdown.
  - Timer-triggered Function (daily) finalizes invoices past `review_due_at` with no open dispute → `status='finalized'` → creates off-session Stripe PaymentIntent (`off_session=true, confirm=true`) against `tenants.stripe_payment_method_id` → on success `status='paid'`, receipt emailed (Postmark) with line items.
  - Dispute within the window: POST `/api/v1/builder/invoices/:id/dispute { reason, evidence_text }` → `status='disputed'`, charge paused, Feasly ops notified; resolution is manual (ops dashboard, epic 06). Disputed invoices never auto-charge.
  - Lost reporting: `lost` requires a reason code (`price / timing / chose_competitor / unresponsive / other`); feeds future analytics, no invoice.
  - All amounts in CAD; receipts in M1 are Postmark-hosted HTML (server-side
    PDF deferred to M6 per TECH_PLAN §2.4 — supersedes the earlier
    "invoice PDFs attached" line).
- **Dependencies:** BLD-004, BLD-011.
- **Size:** L

### BLD-013 — Failed-payment dunning state machine
- **Description:** Grace → degraded embed → suspension. Exact timelines are locked below; the page must never break for the homeowner.
- **Acceptance criteria:**
  - On PaymentIntent failure (or `invoice.payment_failed` webhook for flat subscriptions): `tenants.billing_status='past_due'`, `past_due_since=now()`; retry schedule: immediate, +2d, +5d (Stripe smart retries enabled + our timer Function as backstop); builder emailed at each attempt.
  - **Day 0–7 (grace):** everything works; dashboard shows a persistent "Payment failed — update card" banner; embed fully live.
  - **Day 8–21 (degraded):** `/embed/{key}` serves the fallback card ("This estimator is temporarily unavailable — contact {builder} directly at {fallback_phone/email}"); `loader.js` continues to load (page layout unbroken); lead-gen pauses; builder dashboard banner escalates; Feasly ops alerted at day 8.
  - **Day 22+ (suspended):** `tenants.active=false`; embed returns the same fallback card; builder dashboard locked except Billing; reactivation on successful payment (webhook or manual "retry charge" → success flips `active=true`, `billing_status='current'`).
  - State transitions recorded in `tenant_status_history` (immutable); every transition emails the builder.
  - Timer Function runs daily; all date math in the tenant's timezone (America/Edmonton default per SCHEMA cities).
- **Dependencies:** BLD-004, BLD-005, BLD-007, BLD-012.
- **Size:** M

### BLD-014 — Self-serve plan switching (flat ↔ commission)
- **Description:** Builder can switch plans without talking to us; proration rules are simple and stated up front.
- **Acceptance criteria:**
  - Dashboard → Billing → "Switch plan": shows the same breakeven nudge as BLD-003 recomputed from the builder's actual trailing-90-day wins (avg contract value from `commission_invoices`, count of wins).
  - flat → commission: Stripe subscription canceled at end of current period (`cancel_at_period_end=true`); `tenants.plan='commission'` effective immediately for NEW invoices; no refund of the partial month.
  - commission → flat: subscription created immediately; any `draft` commission invoices stay on the commission track (they were earned under it); no double-billing.
  - Every switch logged to `tenant_status_history` + emailed receipt/summary.
- **Dependencies:** BLD-003, BLD-005, BLD-012.
- **Size:** S

### BLD-015 — Embed health monitoring + Feasly ops alerts
- **Description:** Feasly knows whether each builder's embed is actually installed, loading, and producing leads — before the builder complains.
- **Acceptance criteria:**
  - `loader.js` fires `POST /api/v1/embed/ping { key, page_url }` on every page load (beacon, no PII); iframe load fires `embed_loaded`; lead creation already timestamped.
  - `embed_health` table per tenant: `last_ping_at, last_iframe_load_at, last_lead_at, ping_7d_count`.
  - Ops dashboard (Feasly-internal) lists tenants with: embed never pinged 48h after key issued ("not installed"), pings but zero iframe loads ("snippet misconfigured?"), loads but zero leads in 14d ("traffic or UX issue"), billing_status != current.
  - Alert rules (email to ops): no ping 48h post-activation; ping→no-load for 7d; any tenant entering dunning stages.
  - Builder-facing "Install status" card on their dashboard mirrors the same three signals (installed / loading / receiving leads).
- **Dependencies:** BLD-006, BLD-007, BLD-013.
- **Size:** M

---

### BLD-016 — Embed lead-gate consent disclosure (tenant-aware)
**Description:** On a builder embed, the gate must make the data-sharing
explicit (USER_VALIDATION.md P1-7; the direct feasly.com flow has no such
line — added to WEB-009 here as the consumer): a consent line above the CTA
reads "Your details go to {builder_name}, who may contact you about this
estimate." `{builder_name}` comes from `GET /api/v1/embed/config` (never
from URL params). If the config fails to load, the gate does not render —
no silent default (fail closed: a builder embed must never collect leads
without naming the recipient).

**Acceptance criteria:**
- Consent line renders the builder's display name from the signed config
  (test: config mocked with a different name → line updates; no hardcoded
  name anywhere).
- Config-load failure → gate shows "This estimator is unavailable right now"
  (no lead collection without disclosure).
- Privacy page linked from the line documents the tenant data-sharing model.

- **Dependencies:** BLD-006, BLD-007, WEB-009.
- **Size:** S

---

## Assumptions log

1. **KYC-lite:** no identity documents; email + domain verification + manual ops approval for early tenants. Revisit if fraud appears or payment processors require more.
2. **Status enum unified** to `new/contacted/quoting/won/lost` across consumer (M4) and builder pipelines; SCHEMA.md `leads.status` CHECK will be migrated to match. `qualified`/`closed` are dropped as redundant.
3. **Commission base = gross construction contract value, land excluded.** Contract value is builder-entered at won-reporting; flagged for verification via epic 06 (permit cross-check, homeowner confirmation). Renovations are included in the same 1% (a reno contract is a construction contract); land exclusion applies to new builds.
4. **Flat-plan cancellation:** no mid-cycle refunds; remaining time converts to account credit applied against future commission invoices if the builder later switches to commission.
5. **Dunning timeline:** 7d grace / 14d degraded (days 8–21) / suspension day 22. Timelines are config, not code — stored in a Feasly-operated settings table.
6. **Internal invoice table is the record; Stripe is the rail.** We do NOT use Stripe Invoices — internal `commission_invoices` + PaymentIntent charges + Postmark HTML receipts is simpler and keeps the 7-day review semantics in our control (server-side PDF receipts deferred to M6).
7. **`report_url_template` fallback:** builders who don't configure it get Feasly-hosted magic links; attribution still works via `tenant_id` on the lead.
8. **Embed domain:** `embed.feasly.com` serves `loader.js` and `/embed/{key}`; main app stays on `feasly.com`. (Domain purchase itself is NEEDS-KARAN per ADR.)

## Open questions

- **Q1 [NEEDS-KARAN]: Lawyer-drafted platform agreement** — the launch blocker for this entire epic. Who drafts (his lawyer?), and does Elite sign the same agreement as future builders? (Recommendation: yes — Elite on identical terms is the cleanest precedent.)
- **Q2 [NEEDS-KARAN]: Flat price $X/mo.** Needed before BLD-003/Bld-005 ship. (Recommendation: pick after 2–3 months of Elite pilot data on close rate × avg contract; start commission-only for Elite.)
- **Q3 [NEEDS-KARAN]: Calgary default avg contract value** for the breakeven nudge (placeholder $750k). Validate against Elite's actuals.
- **Q4:** Should builders see each other's anonymized benchmarks (close rate, avg contract) in the dashboard later? (Deferred — not v1; note for roadmap.)
- **Q5:** Chargeback handling beyond Stripe disputes — manual ops process for now; acceptable?
