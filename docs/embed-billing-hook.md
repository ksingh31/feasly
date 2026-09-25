# Embed billing hook (EMB-04)

> **Status:** placeholder. No charge path exists. Nothing bills anyone.
>
> Karan's decision (2026-09-24): **1% of signed contract value (commission)**,
> config-switchable to flat (`BILLING_MODEL=commission|flat`). The hook below
> records where the decision plugs in; the real charge path is a future story.

## The hook

`recordBillableEvent(tenantId, event)` —
`apps/api/src/services/billing/embed-billing-hook.service.ts`
(`createEmbedBillingHookService`, wired in `apps/api/src/composition.ts` as
`embedBillingHookService`).

- `event: 'lead_created' | 'lead_won'`
- Appends exactly one row to `billing_events`
  (`eventType: 'embed.lead_created' | 'embed.lead_won'`,
  `entityType: 'embed_billing_hook'`) via `BillingAuditService` — append-only,
  for future reconciliation.
- Returns `{ billed: false, reason: 'billing_not_enabled' }`. Always.
- Touches no Stripe SDK, no charge code, no webhook. Verified by the
  `no-stripe-in-embed-hook` grep test.

## Where the real billing attaches (future stories)

**Iron rule:** the future billing story DELETES this file's no-op service and
replaces it — it does not build a second hook beside it. The
`billing_events` rows written by the no-op remain as the reconciliation
history.

### If 1% commission (the decided model)

1. `lead_won` events feed `AttributionService`
   (`apps/api/src/services/billing/attribution.service.ts`) — the won-reporting
   path that already exists for the direct track.
2. Attribution → `CommissionService`
   (`apps/api/src/services/billing/commission.service.ts`) creates the
   commission invoice (1% of signed contract value, 14-day reporting SLA).
3. `tenant.plan` (`tenants` table, `'flat' | 'commission' | null`) selects the
   model per tenant; `null` = undecided, the default. The embed builder config
   (`config/builders/{tenantKey}.json` → `tenants` row fallback) surfaces it
   as informational only until billing is enabled.

### If flat (dormant path)

1. `FlatPlanService`
   (`apps/api/src/services/billing/flat-plan.service.ts`) — subscription per
   tenant, dormant until `BILLING_MODEL=flat`.
2. Card-on-file: `tenants.stripe_customer_id` (`cus_…`) is captured at that
   point; today it is never written by the embed track.

### Stripe touchpoints (all outside the hook)

The only Stripe SDK touchpoint is `StripeService`
(`apps/api/src/services/billing/stripe.service.ts`), used by the commission
engine and webhooks — never by the embed hook. The hook file must never import
it (grep test enforces this).

## What `plan = null` means today

Every tenant (including Elite Craft) has `plan = null` (undecided). The embed
works end-to-end with no billing UI and no blocking: the builder config
surfaces `plan` as informational only, and `recordBillableEvent` is not yet
called from any route — it is the hook point waiting for the first caller
(the embed lead-created path, when billing goes live).
