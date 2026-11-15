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

### Payment providers: simulated until Stripe exists (#753)

`StripeService` talks to a `PaymentProvider`
(`apps/api/src/services/billing/payment-provider.ts`). There are two:

| `PAYMENTS_PROVIDER` | Implementation | Secrets |
|---|---|---|
| `simulated` (default when `NODE_ENV=development`, i.e. the deployed dev Function App) | `simulated-payment.provider.ts`: Stripe-shaped objects, statuses, decline messages and event types. State lives in `simulated_payment_objects`. | none (`PAYMENTS_SIMULATED_WEBHOOK_SECRET` is optional; unset means a random secret per process) |
| `stripe` (default everywhere else) | `createStripeSdkClient` in `stripe.service.ts`, the official SDK | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (Key Vault) |

Production refuses to boot with `simulated`.

**Simulated behaviour.** Cards are Stripe's public test numbers
(`SIMULATED_TEST_CARDS` in `@feasly/contracts`). No other number is accepted.

| Card | Save | Off-session charge |
|---|---|---|
| `4242 4242 4242 4242` | succeeds | `succeeded`, then `payment_intent.succeeded` → invoice **paid** |
| `4000 0000 0000 0002` | succeeds | `requires_payment_method` ("Your card was declined."), then `payment_intent.payment_failed` → invoice **failed** |
| `4000 0000 0000 9995` | succeeds | same as above, with "Your card has insufficient funds." |
| `4000 0027 6000 3184` | `requires_action` until 3DS is completed | `requires_action` → complete 3DS → paid, or fail 3DS → failed |

Every state change writes a Stripe-shaped event to an outbox. At delivery
time the event is signed with Stripe's `t=…,v1=…` HMAC scheme and passed to
the **production** webhook route (`StripeWebhooksRoute.handle` →
`BillingWebhookService.handleWebhook`). That means signature verification,
`stripe_events` idempotency and #711 reconciliation all run for real. Charge
events are delivered `PAYMENTS_SIMULATED_WEBHOOK_DELAY_MS` (default 1500 ms)
after the charge, because Stripe webhooks are asynchronous too. Anything left
undelivered goes out on the next dev action, and daily reconciliation reads
the PaymentIntent status from the provider either way.

Test-mode endpoints (each is a 404 unless `simulated` is active):

- `POST /api/v1/billing/simulated/confirm-setup` with `{ setupIntentId, cardNumber }`.
  The builder card modal calls this in place of Stripe Elements when
  `POST /billing/setup-intent` returns `provider: "simulated"`. The field
  must be labelled "Test mode — no real charges" (`SIMULATED_PAYMENTS_NOTICE`).
- `POST /api/v1/billing/simulated/authenticate` with `{ intentId, outcome: "complete" | "fail" }`.
  This is the dev-only "complete 3DS challenge" step, for a SetupIntent or a
  PaymentIntent.
- `POST /api/v1/admin/billing/simulated/invoices/{id}/events` with
  `{ kind: "dispute" | "refund" | "delayed_failure", amountCents? }`.
  This is the admin dev panel. It shows only when
  `GET /api/v1/admin/billing` reports `stripe.provider === "simulated"`.

The provider contract that both implementations follow: a declined
off-session charge comes back as a PaymentIntent **status**, never as a thrown
error. The invoice therefore always records the PaymentIntent id, and the
failure webhook settles it. The Stripe provider reads the PaymentIntent from
`StripeCardError.payment_intent` to do this.

**Going live on Stripe is config only:**

1. Put `STRIPE_SECRET_KEY` (`sk_test_…` outside production, `sk_live_…` in
   production) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`) in Key Vault. Pass
   their secret URIs to `infra/bicep` (`stripeSecretKeySecretUri`,
   `stripeWebhookSecretUri`). The app settings are Key Vault references.
2. Set the app setting `PAYMENTS_PROVIDER=stripe`. Only needed where
   `NODE_ENV=development`; it is already the default elsewhere.
3. In the Stripe dashboard, point the webhook endpoint at
   `POST /api/v1/stripe/webhooks` and subscribe to the event types listed
   in the `BillingWebhookService` dispatch table.

No code changes are needed. The `simulated_payment_objects` rows can be left
in place or truncated.

## What `plan = null` means today

Every tenant (including Elite Craft) has `plan = null` (undecided). The embed
works end-to-end with no billing UI and no blocking: the builder config
surfaces `plan` as informational only, and `recordBillableEvent` is not yet
called from any route — it is the hook point waiting for the first caller
(the embed lead-created path, when billing goes live).
