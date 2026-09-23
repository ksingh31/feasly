# Epic 06 — Attribution (the "make sure we get our 1%" epic)

**Status:** Draft for implementation. No legal blocker of its own, but it is toothless without the platform agreement from epic 05 (reporting SLA, proof-burden rules must exist in the contract first).
**Milestone target:** Ships with/just after the builder platform (epic 05); the permit cross-check additionally depends on epic 01's permit field-verification spike.
**ADR:** `../../adr/ADR-001-architecture.md` | Schema: `../SCHEMA.md`

## Goal

Every Feasly-routed lead that turns into a signed construction contract with the builder produces a commission invoice — even if the builder never reports the win. Three independent detection channels (builder self-report, permit-data cross-check, homeowner confirmation) feed one deduped attribution decision, every decision is audit-logged, and verified matches auto-invoice.

## Non-goals

- Marketplace-phase attribution (match scores, multi-builder routing) — this epic covers single-builder embed attribution only.
- Legal enforcement / collections beyond the dunning machine (epic 05) — disputes here are decided on evidence, then handed to the contract.
- Real-time permit streaming — monthly batch is sufficient (permits lag reality by weeks anyway).
- Detecting contracts the homeowner signs with a *different* builder (out of scope; Feasly's claim is only on the routing builder).

## Key decisions (locked)

1. **Three detection channels, one decision log:** (a) builder self-reports won (epic 05 BLD-012), (b) monthly permit cross-check, (c) homeowner post-close verification emails. Any channel can create an `attribution_event`; dedupe + decision rules below prevent double-invoicing the same contract.
2. **Attribution window: 12 months from lead handoff.** A signed contract counts iff `contract_signed_date` is within 12 months of the most recent qualifying lead event for that homeowner+builder. Bright line: signed on day 366 = not attributable. (A *new* estimate/lead event by the same homeowner starts a fresh 12-month window — the window anchors to the latest handoff.)
3. **Dedup identity at handoff:** same `tenant_id` + (same normalized email OR same normalized phone OR same `address_key`) within 90 days = the same lead. The *first* handoff timestamp anchors the window; later duplicates update the existing lead (consistent with SCHEMA.md's dedupe note) but do not extend the window — only a genuinely new project (new estimate with different scope/address) starts a new window.
4. **Prior-relationship exclusion: proof burden on the builder.** If the builder claims the homeowner was already their customer/prospect, they must upload dated evidence (prior contract, email thread, CRM record) predating the first Feasly handoff, within the 7-day invoice review window. Feasly ops decides; silence = the invoice stands.
5. **Homeowner check-in cadence: 45 / 90 / 120 days** post-handoff, with a carrot (free refreshed estimate + neighbourhood cost-index update). This is a trust play, not an interrogation — copy asks "how's the project going?" first, "did you sign with a builder? which one?" second.
6. **Permit cross-check is monthly** (timer-triggered Function, 1st of month, 02:00 America/Edmonton). Calgary building-permit open data via Socrata; match on address, confirm on applicant name. Dataset field verification (which fields actually exist — esp. applicant/contractor name) comes from epic 01's spike; this epic consumes its result.
7. **Audit log is append-only.** Every attribution decision (flag raised, invoice created, dispute resolved, window applied) writes an immutable row with actor, evidence snapshot, and rationale. This is the dispute-resolution record.

---

## Stories (dependency order)

### ATT-001 — Schema extensions for attribution & billing
- **Description:** Migration adding the tables this epic (and the billing half of epic 05) needs, following SCHEMA.md conventions (uuid PKs, `tenant_id` everywhere, timestamptz, no in-place updates of financial rows).
- **Acceptance criteria:** Single migration file `migrations/00XX_attribution_billing.sql` creates:
  ```sql
  -- One-time auth codes for the iframe token-relay (epic 05 BLD-009)
  CREATE TABLE embed_relay_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    user_id uuid NOT NULL REFERENCES users(id),
    estimate_id uuid REFERENCES estimates(id),
    code_hash text UNIQUE NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Builder billing state on the tenant
  ALTER TABLE tenants ADD COLUMN stripe_customer_id text;
  ALTER TABLE tenants ADD COLUMN stripe_payment_method_id text;
  ALTER TABLE tenants ADD COLUMN plan text NOT NULL DEFAULT 'commission'
    CHECK (plan IN ('flat','commission'));
  ALTER TABLE tenants ADD COLUMN billing_status text NOT NULL DEFAULT 'current'
    CHECK (billing_status IN ('current','past_due','degraded','suspended'));
  ALTER TABLE tenants ADD COLUMN past_due_since timestamptz;
  ALTER TABLE tenants ADD COLUMN branding jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE tenants ADD COLUMN allowed_origins text[] NOT NULL DEFAULT '{}';
  ALTER TABLE tenants ADD COLUMN embed_key text UNIQUE;
  ALTER TABLE tenants ADD COLUMN report_url_template text;

  -- Flat-plan subscriptions (Stripe is the rail; this mirrors state)
  CREATE TABLE subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    stripe_subscription_id text UNIQUE NOT NULL,
    plan text NOT NULL DEFAULT 'flat',
    status text NOT NULL,
    current_period_start timestamptz,
    current_period_end timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Commission invoices (internal record; see epic 05 decision 6)
  CREATE TABLE commission_invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    lead_id uuid NOT NULL REFERENCES leads(id),
    status text NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','finalized','paid','failed','disputed','voided')),
    contract_value_cents int NOT NULL CHECK (contract_value_cents > 0),
    commission_cents int NOT NULL,              -- round(contract_value * 0.01)
    contract_signed_date date,                   -- nullable: permit-triggered
                                                 -- invoices may only know issued_date
    value_source text NOT NULL DEFAULT 'builder_confirmed'
      CHECK (value_source IN ('builder_confirmed','permit_estimate','homeowner_stated')),
    line_items jsonb NOT NULL,
    review_due_at timestamptz NOT NULL,
    finalized_at timestamptz,
    charged_at timestamptz,
    stripe_payment_intent_id text,
    dispute_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX commission_invoices_tenant_status ON commission_invoices (tenant_id, status);

  -- Attribution events from any channel (dedupe key below)
  CREATE TABLE attribution_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    lead_id uuid NOT NULL REFERENCES leads(id),
    kind text NOT NULL CHECK (kind IN ('builder_reported','permit_match','homeowner_confirm')),
    evidence jsonb NOT NULL,                   -- snapshot of what triggered it
    dedupe_key text NOT NULL,                   -- tenant_id:lead_id:contract_signed_date
    invoice_id uuid REFERENCES commission_invoices(id),
    decided_by text NOT NULL,                   -- 'system' | user email
    decision text NOT NULL,                     -- 'attributed' | 'excluded_prior_relationship' | 'outside_window' | 'duplicate'
    decided_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (dedupe_key)
  );

  -- Permit cross-check matches (raw findings before decision)
  CREATE TABLE permit_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    lead_id uuid REFERENCES leads(id),          -- null until matched to a lead
    permit_no text NOT NULL,
    address_key text NOT NULL,
    address_raw text NOT NULL,
    applicant_name text,
    contractor_name text,
    permit_type text,
    issued_date date,
    status text NOT NULL DEFAULT 'unreviewed'
      CHECK (status IN ('unreviewed','matched','dismissed','invoiced')),
    raw jsonb NOT NULL,                         -- full Socrata row snapshot
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, permit_no)
  );

  -- Append-only audit log for every attribution/billing decision
  CREATE TABLE audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity text NOT NULL,                       -- 'commission_invoice' | 'attribution_event' | 'permit_match' | 'tenant'
    entity_id uuid NOT NULL,
    action text NOT NULL,
    actor text NOT NULL,                        -- 'system' | user email
    details jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- No UPDATE/DELETE grants on audit_log for app roles (enforced in migration via REVOKE).

  -- Lead notes + status history (used by builder dashboard, epic 05 BLD-011)
  CREATE TABLE lead_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id uuid NOT NULL REFERENCES leads(id),
    author_user_id uuid REFERENCES users(id),
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE lead_status_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id uuid NOT NULL REFERENCES leads(id),
    from_status text, to_status text NOT NULL,
    changed_by text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE tenant_status_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    from_status text, to_status text NOT NULL,
    reason text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
  );

  -- Unified lead status enum (supersedes SCHEMA.md's qualified/closed)
  ALTER TABLE leads DROP CONSTRAINT leads_status_check;
  ALTER TABLE leads ADD CONSTRAINT leads_status_check
    CHECK (status IN ('new','contacted','quoting','won','lost'));

  -- Embed health signals (epic 05 BLD-015)
  CREATE TABLE embed_health (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    last_ping_at timestamptz,
    last_iframe_load_at timestamptz,
    last_lead_at timestamptz,
    ping_7d_count int NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ```
  Migration is backwards-compatible (new columns nullable or defaulted); `commission_cents` has a CHECK or generated constraint `= round(contract_value_cents * 0.01)`.
- **Dependencies:** epic 01 (migration runner, base schema from SCHEMA.md).
- **Size:** M

### ATT-002 — Attribution decision service (dedupe + window + exclusion rules)
- **Description:** One code path (`packages/attribution` or `apps/api/src/attribution/`) that every channel calls. Encodes the locked rules so permit matches, homeowner confirmations, and builder reports can't double-invoice or contradict each other.
- **Acceptance criteria:**
  - `decideAttribution({ tenant_id, lead_id, kind, evidence, contract_signed_date })`:
    1. Resolves the canonical lead via dedupe identity (email/phone/address_key within 90d); returns the earliest handoff's lead row.
    2. Enforces the 12-month window: `contract_signed_date ≤ first_handoff + 12 months` → else `decision='outside_window'`, no invoice.
    3. Enforces idempotency: `dedupe_key = tenant_id:lead_id:contract_signed_date` unique — a second channel reporting the same contract returns the existing invoice (`decision='duplicate'`).
    4. Returns `{ decision: 'attributed', invoice_id }` for the attributable case; the caller (channel) creates the draft invoice.
  - Prior-relationship exclusion is NOT auto-decided — it is raised as a dispute by the builder (ATT-006); the service records the claim and pauses the invoice.
  - Pure, unit-tested module: fixtures for window edges (day 365 attributable, day 366 not), duplicate suppression across channels, multi-lead same-homeowner resolution to earliest handoff.
  - Every call writes an `audit_log` row regardless of outcome.
- **Dependencies:** ATT-001.
- **Size:** M

### ATT-003 — Monthly permit cross-check job
- **Description:** Timer-triggered Function that matches building permits against Feasly leads and auto-flags conversions the builder didn't report.
- **Acceptance criteria:**
  - Azure Function on a timer (`0 0 2 1 * *` — 02:00 America/Edmonton on the 1st of each month) runs `POST`-internal `runPermitCrossCheck()`.
  - Pulls the City of Calgary Building Permits dataset (Socrata API, incremental: `issued_date` in the last ~40 days to cover late postings). **Exact dataset ID and available fields (esp. applicant/contractor name) come from epic 01's permit field-verification spike — this story consumes that spike's output; if applicant name is unavailable, matching falls back to address-only + manual ops review (flagged in the spike decision).**
  - Matching pipeline per permit row:
    1. Normalize address → `address_key` (same normalizer as `properties`); look up `leads` (joined to `properties`) for that tenant with handoff in the last 12 months.
    2. If address matches AND (applicant/contractor name fuzzy-matches the tenant's business name OR the permit address is the lead's address with a new-build/demolition permit type): create `permit_matches` row (`status='matched'`), then call `decideAttribution(kind='permit_match', evidence=<permit snapshot>)`.
    3. Attributed → auto-create `commission_invoices` draft (contract value = builder-entered? unknown — see below) with `status='draft'`, `review_due_at=+7d`, and notify builder + ops.
  - **Contract value unknown from permits:** draft invoice is created with `contract_value_cents` estimated from the lead's estimate total midpoint, clearly labeled `value_source='permit_estimate'`, and the builder MUST confirm/correct the value in the review window; failure to respond still auto-charges on the estimate (stated in the platform agreement — flagged as a legal-review item in BLD-002's agreement text).
  - Permits matching an address with NO Feasly lead are logged and ignored (not our lead, not our commission).
  - Run summary emailed to ops: permits scanned, matches, invoices drafted, errors.
- **Dependencies:** ATT-001, ATT-002; epic 01 permit field-verification spike (dataset ID + applicant-name availability).
- **Size:** L

### ATT-004 — Homeowner post-close verification emails (45/90/120d)
- **Description:** Friendly check-ins that ask how the project is going and — with a carrot — whether they signed with a builder. Confirmations become attribution evidence.
- **Acceptance criteria:**
  - Timer Function (daily) finds leads with `status NOT IN ('won','lost')` and `created_at` at exactly 45 / 90 / 120 days; sends the corresponding Postmark template:
    - **Day 45:** "How's the project going?" — project-status question + soft ask "have you chosen a builder yet?" Carrot: reply and get a free refreshed estimate.
    - **Day 90:** "Quick check-in — did you sign with {builder_name}?" One-click buttons: "Yes, I signed" / "Still deciding" / "Went another direction". Carrot: updated neighbourhood cost-index report.
    - **Day 120 (final):** "Last check-in" — same one-click options; notes this is the last email on this topic.
  - One-click "Yes, I signed" link carries a signed token (`lead_id` + HMAC) → landing page confirms: "Thanks — which builder did you sign with?" (pre-filled with the routing builder; editable) + optional contract date → submit calls `decideAttribution(kind='homeowner_confirm', evidence=<response>)` → attributed → draft invoice auto-created (same `value_source='permit_estimate'` rule as ATT-003 if value unknown — here the homeowner may optionally enter the contract value).
  - "Went another direction" → lead marked `lost` (reason `chose_other`), no invoice, stops the sequence.
  - Unsubscribe honored per email (CASL); any reply STOPs further check-ins for that lead.
  - All sends + responses logged to `audit_log`; response rate tracked on the ops dashboard.
- **Dependencies:** ATT-001, ATT-002; epic 01 Postmark templates infra.
- **Size:** M

### ATT-005 — Auto-invoice on verified match (no builder report needed)
- **Description:** The teeth: a permit match or homeowner confirmation creates a draft invoice even if the builder never marked the lead won. Builder gets the 7-day review, then auto-charge.
- **Acceptance criteria:**
  - Both ATT-003 and ATT-004 call the shared `createDraftInvoiceFromAttribution(attribution_event_id)` — single code path, not per-channel logic.
  - Draft invoice is visually distinguished in the builder dashboard: badge "Auto-detected — please confirm contract value", countdown to `review_due_at`, dispute button (→ ATT-006).
  - Finalization reuses epic 05's finalize-and-charge timer (BLD-012): on `review_due_at` with no open dispute → `finalized` → off-session PaymentIntent → `paid`/`failed` (failures enter the dunning machine, BLD-013).
  - Builder CANNOT delete an auto-detected draft — only dispute it (with evidence) or confirm/correct the value.
  - If the builder had already self-reported the same contract first, `dedupe_key` collapses the second event to `duplicate` — exactly one invoice per contract, always.
- **Dependencies:** ATT-002, ATT-003, ATT-004; BLD-012 (finalize/charge).
- **Size:** S (mostly wiring, given ATT-002–004)

### ATT-006 — Dispute rules & resolution queue
- **Description:** Builders can dispute auto-detected or self-reported invoices, but the burden of proof is theirs and the clock keeps ticking on everything else.
- **Acceptance criteria:**
  - Dispute reasons (enum): `prior_relationship` | `wrong_address` | `wrong_value` | `not_our_contract` | `outside_window`.
  - `prior_relationship` requires uploaded evidence (file ≤10MB or dated text: prior contract, email thread, CRM export) with an evidence date PREDATING the first Feasly handoff; server validates the claimed date < handoff date, else auto-reject with explanation.
  - `wrong_value` requires the corrected `contract_value_cents`; invoice is re-computed (still 1%), review clock restarts at 7 days from correction.
  - Disputed invoice → `status='disputed'`, charge paused; appears in the Feasly ops dispute queue (ATT-007) with SLA: ops decision within 5 business days; builder notified of the decision by email with rationale; decision + evidence snapshot → `audit_log` (immutable).
  - "Deal revived after window": contract signed >12 months after handoff is NOT attributable, full stop — EXCEPT if a new qualifying lead event (new estimate) occurred after the original handoff, which re-anchors the window (decision 2). Documented in the dispute UI copy so builders see the rule before disputing.
  - Reno-vs-new-build scope rule: the 1% applies to any construction contract (new build or reno) signed with the routing builder inside the window; land value excluded from the base in all cases. No separate reno rate in v1.
- **Dependencies:** ATT-001, ATT-005.
- **Size:** M

### ATT-007 — Feasly ops attribution dashboard
- **Description:** The internal screen where Feasly watches the money: flags, SLA breaches, dispute queue, and run health.
- **Acceptance criteria:**
  - Internal-only route (Feasly ops auth, NOT builder-visible) with flag queues:
    - **Permit-match unreported:** `permit_matches.status='matched'` with no linked invoice after 48h.
    - **Homeowner-confirmed unreported:** `attribution_events.kind='homeowner_confirm'` with no linked invoice after 48h.
    - **Reporting SLA overdue:** leads in `quoting` > 60 days with no status movement, or permits suggesting activity with no builder update (surfaces "are they sitting on a win?").
    - **Dispute queue:** open disputes sorted by oldest, with evidence viewer and accept/reject actions (→ writes `audit_log`, notifies builder).
  - Per-tenant rollup: leads routed, wins reported, auto-detected invoices, dispute rate, billing_status — the "is this builder playing straight?" view.
  - Permit job health: last run time, permits scanned, match rate, errors (alerts ops on run failure).
  - Homeowner email stats: send/open/click/response rates per wave (45/90/120).
- **Dependencies:** ATT-003, ATT-004, ATT-006.
- **Size:** M

### ATT-008 — Reporting SLA enforcement (14-day rule)
- **Description:** The platform agreement requires builders to report won/lost within 14 days of the decision. This story makes the SLA visible and consequential without being a jerk about it on day 15.
- **Acceptance criteria:**
  - The agreement (epic 05 BLD-002) states the 14-day SLA; this story implements the operational side: when a permit match or homeowner confirmation indicates a signed contract, the builder is notified "a possible win was detected — please confirm within 14 days."
  - If the builder confirms/corrects within 14 days: normal flow, no penalty, invoice uses the builder-confirmed value.
  - If 14 days pass with no response: invoice finalizes on the estimated value (`value_source='permit_estimate'` or homeowner-stated value) and a `sla_breach` flag is recorded on the tenant (visible in ATT-007 rollup; repeated breaches are grounds for agreement remedies per the legal text).
  - Builder dashboard shows a persistent "action needed" list with per-item deadlines — the SLA is never a surprise.
- **Dependencies:** ATT-003, ATT-004, BLD-012.
- **Size:** S

---

### ATT-009 — Permit-triggered invoice semantics + pilot confirm-value mode
**Description:** Closes USER_VALIDATION.md P1-9's three gaps. (1) Permit
detections don't produce a contract date or value: invoice uses
`contract_signed_date = NULL` (nullable per the DDL above — a permit's
`issued_date` lives in `evidence`, never masquerades as a signed date) and
`value_source='permit_estimate'` (estimate midpoint). (2) Estimated-value
auto-charge is a **per-tenant flag** `tenants.estimated_value_autocharge`
(default **false**): when false, a permit/homeowner-stated invoice stays
`in_review` past `review_due_at` and escalates to ops + builder as "confirm
contract value to proceed" — it never auto-charges an estimate. (3) Default
policy: **Elite pilot runs confirm-value-required** (preserve the
relationship); auto-charge on estimates activates from builder #2 onward
once the agreement language is battle-tested.

**Acceptance criteria:**
- Invoice from a permit match carries `contract_signed_date IS NULL`,
  `value_source='permit_estimate'` (asserted in tests).
- With the flag off: `review_due_at` passes → invoice stays `in_review`,
  ops alerted, builder dashboard shows "confirm value" action; no
  PaymentIntent created (test asserts zero Stripe writes).
- With the flag on: standard auto-charge flow after the review window.
- Tenant setting is admin-editable and audit-logged.

- **Dependencies:** ATT-003, ATT-004, BLD-002 (agreement language).
- **Size:** M
**NEEDS-KARAN:** Q1 — confirm confirm-value-required for the Elite pilot
(recommended) vs auto-charge from day one.

---

## Assumptions log

1. **Permit data is a lagging, imperfect signal.** Monthly batch is enough; permits appear weeks after signing. Address matching uses the same `address_key` normalizer as the properties cache; applicant-name confirmation depends on epic 01's field-verification spike — if the dataset lacks applicant names, matches go to manual ops review instead of auto-invoice (downgrade path, decided then).
2. **Estimated contract values are chargeable only when the tenant's
   `estimated_value_autocharge` flag is on.** Both permit matches and homeowner
   confirmations may lack the true contract value; the draft uses the lead's
   estimate midpoint, labeled `value_source='permit_estimate'` (or
   `'homeowner_stated'`), and auto-charges after the review window only if the
   flag is enabled — default OFF (Elite pilot: confirm-value-required). This
   MUST be explicit in the platform agreement (flagged for the lawyer in
   BLD-002).
3. **12-month window anchors to the latest qualifying handoff,** and only a genuinely new project (new estimate/lead event) re-anchors it — duplicate leads from the same project do not extend the window.
4. **Homeowner emails are check-ins with a carrot, not accusations.** Copy stays in the "how's your project going?" register per the product principle (simple, sticky, trustworthy — never feels like a data grab). Unsubscribe is honored instantly.
5. **One invoice per contract, always.** `dedupe_key` uniqueness is the backstop; channels are additive for detection, never multiplicative for billing.
6. **`audit_log` is append-only at the database level** (REVOKE UPDATE/DELETE from app roles in the migration). Dispute evidence snapshots are stored in `evidence` jsonb at decision time so later edits can't rewrite history.
7. **Reno contracts are in scope for the 1%** (same rate, same window); land exclusion applies to new-build contract values. No separate reno commission tier in v1.

## Open questions

- **Q1 [NEEDS-KARAN]:** Is auto-charging on an *estimated* contract value (when the builder doesn't respond) acceptable business posture for the pilot, or should Elite's pilot run "confirm-value-required" (no auto-charge without a confirmed number)? (Recommendation: confirm-value-required for the Elite pilot — preserve the relationship; enforce auto-charge from builder #2 onward once the agreement language is battle-tested.)
- **Q2:** Permit dataset — if applicant/contractor name fields don't exist (epic 01 spike outcome), do we still auto-invoice on address+permit-type match, or route all of them to manual ops review? (Recommendation: manual review until the false-positive rate is measured; auto-invoice only after one clean quarter.)
- **Q3:** Should the homeowner "which builder did you sign with?" answer be shown to the routing builder? (Recommendation: no — show only that a contract was signed and the date; the builder name answer is Feasly-internal evidence to avoid poisoning the relationship.)
- **Q4:** Cross-builder poaching (homeowner routed to builder A signs with builder B): currently out of scope — but should the homeowner confirmation at least *record* it for future marketplace design? (Recommendation: yes, record `signed_with_other_builder=true` in evidence jsonb; no action in v1.)
- **Q5:** Do permit-match invoices apply to builders on the flat plan too? (Recommendation: no — flat plan is unlimited; attribution/invoicing is commission-plan only. A flat-plan builder's permit matches are still logged for calibration data.)
