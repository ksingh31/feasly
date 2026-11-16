/**
 * Commission card-on-file service (billing/02, BILL-02; lifecycle #716).
 *
 * The commission charge path (`finalizeInvoice`) charges via
 * `stripe.createOffSessionPaymentIntent({ customerId })`, but under
 * `BILLING_MODEL=commission` there was no way for a tenant to get a Stripe
 * customer or save a card — every finalization threw BILLING_NOT_CONFIGURED.
 * This service closes that gap: commission-scoped customer ensure +
 * SetupIntent creation + card-status reads, all tenant-scoped and
 * model-gated (409 BILLING_MODEL_MISMATCH under flat, mirroring the flat
 * path's own gate).
 *
 * #716 card lifecycle — ONE card per builder (owner decision 2026-11-15):
 * - Saving a card makes it the customer's
 *   `invoice_settings.default_payment_method` and detaches every other card
 *   (`setup_intent.succeeded` webhook; `getCard` self-heals the same way if
 *   the webhook is late). Both providers charge the default explicitly.
 * - `removeCard` detaches the card — blocked (409) while an unpaid invoice
 *   is set to be charged to it.
 * - `getCard` flags a card whose expiry month ends within
 *   BILLING_CARD_EXPIRY_WARNING_DAYS (`expiresSoon`) or has passed
 *   (`expired`).
 * - The Stripe customer carries the builder's business name, email and
 *   builder id, re-synced when the builder profile changes.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts. This service never touches db directly.
 */
import type { Builder, BuilderBillingAddress } from '@feasly/contracts';
import type { BillingConfig } from '../../config';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { BillingAuditService } from './billing-audit.service';
import type { InvoiceSummaryStore } from './invoice-summary.store';
import type {
  CardSummary,
  NormalizedStripeEvent,
  StripeService,
} from './stripe.service';
import type { CustomerAddress } from './payment-provider';

/** #881: the builder's billing address in the provider's (Stripe) shape. */
function toCustomerAddress(a: BuilderBillingAddress): CustomerAddress {
  return {
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.province,
    postalCode: a.postalCode,
    country: a.country,
  };
}

export interface CommissionCardStatus {
  readonly hasCard: boolean;
  readonly brand?: string;
  readonly last4?: string;
  readonly expMonth?: number;
  readonly expYear?: number;
  /** #716: expiry month ends within the configured warning window. */
  readonly expiresSoon?: boolean;
  /** #716: expiry month has already ended. */
  readonly expired?: boolean;
}

/** #716: the card events the webhook dispatcher hands to this service. */
export const CARD_WEBHOOK_EVENTS = [
  'setup_intent.succeeded',
  'setup_intent.setup_failed',
  'payment_method.detached',
  'payment_method.updated',
  'payment_method.automatically_updated',
  'customer.deleted',
] as const;

export type CardWebhookEventType = (typeof CARD_WEBHOOK_EVENTS)[number];

export function isCardWebhookEvent(type: string): type is CardWebhookEventType {
  return (CARD_WEBHOOK_EVENTS as readonly string[]).includes(type);
}

export interface CommissionCardService {
  /**
   * Ensure the tenant has a Stripe customer (idempotent — returns the
   * existing customer id when already created). Commission model only.
   */
  ensureCustomer(tenantKey: string, email?: string): Promise<string>;
  /**
   * Create a SetupIntent for card-on-file capture (builder portal →
   * Stripe Elements). Returns the client secret for the frontend.
   * Commission model only.
   */
  createSetupIntent(tenantKey: string): Promise<{
    setupIntentId: string;
    clientSecret: string;
    /** #753: `simulated` → the portal shows the test-card picker. */
    provider?: 'stripe' | 'simulated';
  }>;
  /**
   * Card-on-file status for the builder portal. Never includes the PAN —
   * brand/last4/expiry only. Commission model only.
   */
  getCard(tenantKey: string): Promise<CommissionCardStatus>;
  /**
   * #716: remove the card on file. 409 while an unpaid invoice is set to
   * be charged to the card. Idempotent: no card → `{ hasCard: false }`.
   * Commission model only.
   */
  removeCard(tenantKey: string): Promise<CommissionCardStatus>;
  /**
   * #716: react to a card webhook event (see CARD_WEBHOOK_EVENTS). Throws
   * only on a provider failure the webhook should retry.
   */
  handleCardEvent(
    event: NormalizedStripeEvent,
    tenantKey: string | null,
  ): Promise<void>;
  /**
   * #716: push the builder's business name / email / id to their Stripe
   * customer. No-op when billing is dormant, the model is flat, or the
   * builder has no customer yet.
   */
  syncCustomerDetails(builder: Builder): Promise<void>;
}

export interface CommissionCardServiceDeps {
  readonly billing: BillingConfig;
  readonly audit: BillingAuditService;
  readonly stripe: StripeService;
  /** #716: blocks card removal while a card invoice is unpaid. */
  readonly invoiceSummaries?: Pick<InvoiceSummaryStore, 'findByTenantKey'>;
  /** #716: business name + builder id for the Stripe customer. */
  readonly builders?: {
    getByTenantKey(tenantKey: string): Promise<Builder | null>;
  };
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
  /** Warning sink for best-effort steps. Defaults to console.warn. */
  readonly logWarning?: (message: string) => void;
}

/** Default "expires soon" window when config omits it (#716). */
const DEFAULT_EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Unpaid statuses that can still end in a card charge: in review (the
 * timer charges it), finalized (charge in flight), failed (retried),
 * draft, and disputed (a "resume" outcome re-enters review).
 */
const CARD_CHARGEABLE_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'in_review',
  'finalized',
  'failed',
  'disputed',
]);

/**
 * Card expiry flags. A card is valid through the last day of its expiry
 * month, so it expires at 00:00 UTC on the first of the following month.
 */
export function cardExpiryFlags(
  card: Pick<CardSummary, 'expMonth' | 'expYear'>,
  now: Date,
  warningDays: number,
): { readonly expiresSoon: boolean; readonly expired: boolean } {
  if (!card.expMonth || !card.expYear) {
    return { expiresSoon: false, expired: false };
  }
  // Date.UTC month is 0-based, so expMonth (1-12) is already "next month".
  const expiresAtMs = Date.UTC(card.expYear, card.expMonth, 1);
  const remainingMs = expiresAtMs - now.getTime();
  const expired = remainingMs <= 0;
  return {
    expired,
    expiresSoon: !expired && remainingMs <= warningDays * DAY_MS,
  };
}

export function createCommissionCardService(
  deps: CommissionCardServiceDeps,
): CommissionCardService {
  const { billing, audit, stripe } = deps;
  const now = deps.now ?? (() => new Date());
  const logWarning =
    deps.logWarning ?? ((message: string) => console.warn(message));
  const warningDays = billing.cardExpiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS;

  function requireCommissionModel(): void {
    if (billing.model !== 'commission') {
      throw new HttpError(
        409,
        ErrorCodes.BILLING_MODEL_MISMATCH,
        `Commission billing is disabled: BILLING_MODEL='${billing.model}'`,
      );
    }
  }

  function requireConfigured(): void {
    if (!stripe.isConfigured) {
      throw new HttpError(
        422,
        ErrorCodes.VALIDATION_FAILED,
        "Card setup isn't available yet — billing is not configured.",
      );
    }
  }

  function toStatus(card: CardSummary): CommissionCardStatus {
    return {
      hasCard: true,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      ...cardExpiryFlags(card, now(), warningDays),
    };
  }

  /**
   * Single-card model: the newest saved card is the one the builder chose
   * (saving a card replaces the old one). Make it the default and detach
   * every other card. Idempotent — safe from the webhook, its redelivery,
   * and a self-healing read.
   */
  async function promoteNewestCard(
    tenantKey: string | null,
    customerId: string,
    cards: readonly CardSummary[],
  ): Promise<CardSummary | null> {
    const chosen = cards[0];
    if (!chosen) return null;
    if (chosen.id) {
      const currentDefault = await stripe.getDefaultPaymentMethodId(customerId);
      if (currentDefault !== chosen.id) {
        await stripe.setDefaultPaymentMethod(customerId, chosen.id);
        await audit.append({
          tenantKey,
          eventType: 'payment_method.default_set',
          entityType: 'stripe_payment_method',
          entityId: chosen.id,
          payload: { customerId, previousDefault: currentDefault },
        });
      }
    }
    for (const old of cards.slice(1)) {
      if (!old.id) continue;
      await stripe.detachPaymentMethod(old.id);
      await audit.append({
        tenantKey,
        eventType: 'payment_method.replaced',
        entityType: 'stripe_payment_method',
        entityId: old.id,
        payload: { customerId, replacedBy: chosen.id ?? null },
      });
    }
    return chosen;
  }

  async function customerDetails(
    tenantKey: string,
    email?: string,
  ): Promise<{
    tenantKey: string;
    email?: string;
    name?: string;
    builderId?: string;
    address?: CustomerAddress;
  }> {
    const builder = deps.builders
      ? await deps.builders.getByTenantKey(tenantKey)
      : null;
    const builderEmail = builder?.email ?? undefined;
    return {
      tenantKey,
      ...(builderEmail || email ? { email: builderEmail ?? email } : {}),
      ...(builder ? { name: builder.businessName, builderId: builder.id } : {}),
      ...(builder?.billingAddress
        ? { address: toCustomerAddress(builder.billingAddress) }
        : {}),
    };
  }

  /** Unpaid invoices that would charge the card (newest first). */
  async function chargeableCardInvoices(
    tenantKey: string,
  ): Promise<readonly { invoiceNumber: string }[]> {
    if (!deps.invoiceSummaries) return [];
    const invoices = await deps.invoiceSummaries.findByTenantKey(tenantKey);
    return invoices.filter(
      (inv) =>
        inv.paymentMethod === 'card' && CARD_CHARGEABLE_STATUSES.has(inv.status),
    );
  }

  async function syncCustomerDetails(builder: Builder): Promise<void> {
    if (billing.model !== 'commission' || !stripe.isConfigured) return;
    const customerId = await stripe.getCustomerId(builder.tenantKey);
    if (!customerId) return;
    await stripe.updateCustomer(customerId, {
      tenantKey: builder.tenantKey,
      name: builder.businessName,
      builderId: builder.id,
      ...(builder.email ? { email: builder.email } : {}),
      ...(builder.billingAddress
        ? { address: toCustomerAddress(builder.billingAddress) }
        : {}),
    });
    await audit.append({
      tenantKey: builder.tenantKey,
      eventType: 'customer.details_synced',
      entityType: 'stripe_customer',
      entityId: customerId,
      payload: { builderId: builder.id },
    });
  }

  return {
    async ensureCustomer(tenantKey: string, email?: string): Promise<string> {
      requireCommissionModel();
      requireConfigured();
      const existing = await stripe.getCustomerId(tenantKey);
      if (existing) {
        // #716: customers created before the business name was sent get it
        // on their next card setup. Best-effort — never blocks the setup.
        const builder = deps.builders
          ? await deps.builders.getByTenantKey(tenantKey)
          : null;
        if (builder) {
          try {
            await syncCustomerDetails(builder);
          } catch (error) {
            logWarning(
              `commission-card: customer details sync failed for tenant ${tenantKey} ` +
                `(${error instanceof Error ? error.message : 'unknown error'})`,
            );
          }
        }
        return existing;
      }
      // Deterministic idempotency key: concurrent ensureCustomer calls for the
      // same tenant collapse into one Stripe customer instead of creating
      // duplicates (check-then-create race, 2026-09-28).
      const customer = await stripe.createCustomer(
        await customerDetails(tenantKey, email),
        `feasly-customer-${tenantKey}`,
      );
      await stripe.saveCustomerId(tenantKey, customer.id);
      await audit.append({
        tenantKey,
        eventType: 'customer.created',
        entityType: 'stripe_customer',
        entityId: customer.id,
        payload: { plan: 'commission' },
      });
      return customer.id;
    },

    async createSetupIntent(tenantKey: string): Promise<{
      setupIntentId: string;
      clientSecret: string;
      provider?: 'stripe' | 'simulated';
    }> {
      requireCommissionModel();
      requireConfigured();
      const customerId = await stripe.getCustomerId(tenantKey);
      if (!customerId) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Tenant "${tenantKey}" has no Stripe customer yet — call ensureCustomer first`,
        );
      }
      const intent = await stripe.createSetupIntent(customerId);
      await audit.append({
        tenantKey,
        eventType: 'setup_intent.created',
        entityType: 'stripe_setup_intent',
        entityId: intent.id,
        payload: { customerId, plan: 'commission' },
      });
      return {
        setupIntentId: intent.id,
        clientSecret: intent.clientSecret,
        ...(stripe.provider ? { provider: stripe.provider } : {}),
      };
    },

    async getCard(tenantKey: string): Promise<CommissionCardStatus> {
      requireCommissionModel();
      if (!stripe.isConfigured) {
        return { hasCard: false };
      }
      const customerId = await stripe.getCustomerId(tenantKey);
      if (!customerId) {
        return { hasCard: false };
      }
      const cards: readonly CardSummary[] =
        await stripe.listPaymentMethods(customerId);
      const newest = cards[0];
      if (!newest) {
        return { hasCard: false };
      }
      // Self-heal when the setup webhook is late or a legacy customer has
      // several cards: the card shown must be the card charged. Best-effort
      // — the read never fails because a detach did.
      try {
        await promoteNewestCard(tenantKey, customerId, cards);
      } catch (error) {
        logWarning(
          `commission-card: default-card reconcile failed for tenant ${tenantKey} ` +
            `(${error instanceof Error ? error.message : 'unknown error'})`,
        );
      }
      return toStatus(newest);
    },

    async removeCard(tenantKey: string): Promise<CommissionCardStatus> {
      requireCommissionModel();
      requireConfigured();
      const customerId = await stripe.getCustomerId(tenantKey);
      if (!customerId) return { hasCard: false };
      const cards = await stripe.listPaymentMethods(customerId);
      if (cards.length === 0) return { hasCard: false };
      const blocking = await chargeableCardInvoices(tenantKey);
      const first = blocking[0];
      if (first) {
        const which =
          blocking.length === 1
            ? `invoice ${first.invoiceNumber} is`
            : `${blocking.length} unpaid invoices are`;
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `This card can't be removed yet: ${which} set to be charged to it. ` +
            'Switch each to cheque, e-transfer or bank draft, or save a new ' +
            'card to replace this one.',
          false,
        );
      }
      for (const card of cards) {
        if (!card.id) continue;
        await stripe.detachPaymentMethod(card.id);
        await audit.append({
          tenantKey,
          eventType: 'payment_method.removed',
          entityType: 'stripe_payment_method',
          entityId: card.id,
          payload: { customerId, plan: 'commission' },
        });
      }
      return { hasCard: false };
    },

    async handleCardEvent(
      event: NormalizedStripeEvent,
      tenantKey: string | null,
    ): Promise<void> {
      const entityId = event.paymentMethodId ?? event.customerId ?? event.id;
      const base = {
        customerId: event.customerId ?? null,
        stripeEventId: event.id,
      };
      switch (event.type) {
        case 'setup_intent.succeeded': {
          await audit.append({
            tenantKey,
            eventType: 'setup_intent.succeeded',
            entityType: 'stripe_payment_method',
            entityId,
            payload: base,
          });
          // Flat-model cards live on the subscription — leave them alone.
          if (billing.model !== 'commission' || !event.customerId) return;
          const cards = await stripe.listPaymentMethods(event.customerId);
          // A redelivered event for a card since replaced/removed: the
          // current newest card already won — nothing to promote.
          if (
            event.paymentMethodId &&
            !cards.some((c) => c.id === event.paymentMethodId)
          ) {
            return;
          }
          await promoteNewestCard(tenantKey, event.customerId, cards);
          return;
        }
        case 'setup_intent.setup_failed':
          await audit.append({
            tenantKey,
            eventType: 'setup_intent.setup_failed',
            entityType: 'stripe_setup_intent',
            entityId,
            payload: { ...base, failureMessage: event.failureMessage ?? null },
          });
          return;
        case 'payment_method.detached':
        case 'payment_method.updated':
        case 'payment_method.automatically_updated':
          // GET /billing/card reads the card live from the provider, so a
          // dashboard detach or a card-updater expiry change shows on the
          // next load. The audit row is the reconciliation trail.
          await audit.append({
            tenantKey,
            eventType: event.type,
            entityType: 'stripe_payment_method',
            entityId,
            payload: base,
          });
          return;
        case 'customer.deleted': {
          const cleared = event.customerId
            ? await stripe.clearCustomerId(event.customerId)
            : null;
          await audit.append({
            tenantKey: tenantKey ?? cleared,
            eventType: 'customer.deleted',
            entityType: 'stripe_customer',
            entityId: event.customerId ?? event.id,
            payload: { ...base, clearedTenant: cleared !== null },
          });
          return;
        }
        default:
          return;
      }
    },

    syncCustomerDetails,
  };
}
