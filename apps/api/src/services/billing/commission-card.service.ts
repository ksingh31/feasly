/**
 * Commission card-on-file service (billing/02, BILL-02).
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
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts. This service never touches db directly.
 */
import type { BillingConfig } from '../../config';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { BillingAuditService } from './billing-audit.service';
import type { CardSummary, StripeService } from './stripe.service';

export interface CommissionCardStatus {
  readonly hasCard: boolean;
  readonly brand?: string;
  readonly last4?: string;
  readonly expMonth?: number;
  readonly expYear?: number;
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
  }>;
  /**
   * Card-on-file status for the builder portal. Never includes the PAN —
   * brand/last4/expiry only. Commission model only.
   */
  getCard(tenantKey: string): Promise<CommissionCardStatus>;
}

export interface CommissionCardServiceDeps {
  readonly billing: BillingConfig;
  readonly audit: BillingAuditService;
  readonly stripe: StripeService;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
}

export function createCommissionCardService(
  deps: CommissionCardServiceDeps,
): CommissionCardService {
  const { billing, audit, stripe } = deps;

  function requireCommissionModel(): void {
    if (billing.model !== 'commission') {
      throw new HttpError(
        409,
        ErrorCodes.BILLING_MODEL_MISMATCH,
        `Commission billing is disabled: BILLING_MODEL='${billing.model}'`,
      );
    }
  }

  return {
    async ensureCustomer(tenantKey: string, email?: string): Promise<string> {
      requireCommissionModel();
      if (!stripe.isConfigured) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          "Card setup isn't available yet — billing is not configured.",
        );
      }
      const existing = await stripe.getCustomerId(tenantKey);
      if (existing) return existing;
      const customer = await stripe.createCustomer({ tenantKey, email });
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
    }> {
      requireCommissionModel();
      if (!stripe.isConfigured) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          "Card setup isn't available yet — billing is not configured.",
        );
      }
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
      return { setupIntentId: intent.id, clientSecret: intent.clientSecret };
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
      const first = cards[0];
      if (!first) {
        return { hasCard: false };
      }
      return {
        hasCard: true,
        brand: first.brand,
        last4: first.last4,
        expMonth: first.expMonth,
        expYear: first.expYear,
      };
    },
  };
}
