/**
 * Flat-plan billing (billing/02).
 *
 * The DORMANT path: built, tested, but inactive until
 * `BILLING_MODEL=flat` (Karan 2026-09-24 — switching models is a config
 * change, never a code change). Stripe customer per tenant, card-on-file at
 * signup via SetupIntent, recurring subscription, webhook-driven dunning.
 *
 * Every state change appends one `billing_events` row.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import type { BillingConfig } from '../../config';
import { HttpError, ErrorCodes } from '../../middleware/errors';
import type { BillingAuditService } from './billing-audit.service';
import type { StripeService } from './stripe.service';
import type { EmailService } from '../email/email.service';

export interface FlatPlanService {
  /**
   * Ensure a Stripe customer exists for the tenant (card-on-file gate).
   * Returns the customer id; creates one when absent.
   */
  ensureCustomer(tenantKey: string, email?: string): Promise<string>;
  /**
   * Create a SetupIntent for card-on-file capture (dashboard → Stripe
   * Elements). Returns the client secret for the frontend.
   */
  createSetupIntent(tenantKey: string): Promise<{
    setupIntentId: string;
    clientSecret: string;
  }>;
  /** Start the flat subscription (requires a card on file). */
  activateSubscription(tenantKey: string): Promise<{ subscriptionId: string }>;
  /** Cancel the flat subscription immediately. */
  cancelSubscription(tenantKey: string, subscriptionId: string): Promise<void>;
  /**
   * Webhook: `invoice.payment_failed` on the flat subscription → dunning
   * email to the builder + ops alert. Webhook: `invoice.payment_succeeded`
   * → audit row, dunning cleared.
   */
  handleInvoicePaymentFailed(input: {
    invoiceId: string;
    subscriptionId?: string;
    customerId?: string;
    tenantKey?: string;
  }): Promise<void>;
  handleInvoicePaymentSucceeded(input: {
    invoiceId: string;
    subscriptionId?: string;
    tenantKey?: string;
  }): Promise<void>;
}

export interface FlatPlanServiceDeps {
  readonly billing: BillingConfig;
  readonly audit: BillingAuditService;
  readonly stripe: StripeService;
  readonly email: EmailService;
  /** Ops inbox for dunning alerts. */
  readonly opsInbox: string;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
}

export function createFlatPlanService(
  deps: FlatPlanServiceDeps,
): FlatPlanService {
  const { billing, audit, stripe, email } = deps;
  const now = deps.now ?? (() => new Date());

  function requireFlatModel(): void {
    if (billing.model !== 'flat') {
      throw new HttpError(
        409,
        ErrorCodes.BILLING_MODEL_MISMATCH,
        `Flat billing is disabled: BILLING_MODEL='${billing.model}'`,
      );
    }
  }

  function requirePriceId(): string {
    const priceId = billing.stripeFlatPriceId;
    if (!priceId) {
      throw new HttpError(
        503,
        ErrorCodes.BILLING_NOT_CONFIGURED,
        'Flat billing is not configured: STRIPE_FLAT_PRICE_ID is not set',
      );
    }
    return priceId;
  }

  return {
    async ensureCustomer(tenantKey: string, emailAddr?: string): Promise<string> {
      requireFlatModel();
      const existing = await stripe.getCustomerId(tenantKey);
      if (existing) return existing;
      const customer = await stripe.createCustomer({
        tenantKey,
        email: emailAddr,
      });
      await stripe.saveCustomerId(tenantKey, customer.id);
      await audit.append({
        tenantKey,
        eventType: 'customer.created',
        entityType: 'stripe_customer',
        entityId: customer.id,
        payload: { plan: 'flat' },
      });
      return customer.id;
    },

    async createSetupIntent(tenantKey: string): Promise<{
      setupIntentId: string;
      clientSecret: string;
    }> {
      requireFlatModel();
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
        payload: { customerId },
      });
      return { setupIntentId: intent.id, clientSecret: intent.clientSecret };
    },

    async activateSubscription(
      tenantKey: string,
    ): Promise<{ subscriptionId: string }> {
      requireFlatModel();
      const priceId = requirePriceId();
      const customerId = await stripe.getCustomerId(tenantKey);
      if (!customerId) {
        throw new HttpError(
          422,
          ErrorCodes.BILLING_NOT_CONFIGURED,
          `Tenant "${tenantKey}" has no card on file — cannot start the flat subscription`,
        );
      }
      const subscription = await stripe.createSubscription({
        customerId,
        priceId,
      });
      await audit.append({
        tenantKey,
        eventType: 'subscription.created',
        entityType: 'stripe_subscription',
        entityId: subscription.id,
        payload: {
          customerId,
          priceId,
          planName: billing.flatPlanName,
          monthlyCents: billing.flatMonthlyCents,
          currency: billing.flatCurrency,
          status: subscription.status,
        },
      });
      return { subscriptionId: subscription.id };
    },

    async cancelSubscription(
      tenantKey: string,
      subscriptionId: string,
    ): Promise<void> {
      requireFlatModel();
      await stripe.cancelSubscription(subscriptionId);
      await audit.append({
        tenantKey,
        eventType: 'subscription.cancelled',
        entityType: 'stripe_subscription',
        entityId: subscriptionId,
        payload: {},
      });
    },

    async handleInvoicePaymentFailed(input: {
      invoiceId: string;
      subscriptionId?: string;
      customerId?: string;
      tenantKey?: string;
    }): Promise<void> {
      // Webhook-driven: the model gate does not apply — a failed Stripe
      // invoice must be recorded whichever model is active.
      await audit.append({
        tenantKey: input.tenantKey ?? null,
        eventType: 'invoice.payment_failed',
        entityType: 'stripe_invoice',
        entityId: input.invoiceId,
        payload: {
          subscriptionId: input.subscriptionId ?? null,
          customerId: input.customerId ?? null,
        },
      });
      await email.sendOpsAlert({
        to: deps.opsInbox,
        title: 'Flat-plan payment failed — dunning',
        summary:
          `Stripe invoice ${input.invoiceId} failed` +
          (input.tenantKey ? ` for tenant ${input.tenantKey}` : '') +
          `. Update the card on file to keep the flat plan active.`,
        firedAt: now(),
      });
    },

    async handleInvoicePaymentSucceeded(input: {
      invoiceId: string;
      subscriptionId?: string;
      tenantKey?: string;
    }): Promise<void> {
      await audit.append({
        tenantKey: input.tenantKey ?? null,
        eventType: 'invoice.payment_succeeded',
        entityType: 'stripe_invoice',
        entityId: input.invoiceId,
        payload: {
          subscriptionId: input.subscriptionId ?? null,
          dunningCleared: true,
        },
      });
    },
  };
}
