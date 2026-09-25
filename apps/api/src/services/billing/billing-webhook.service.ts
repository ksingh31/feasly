/**
 * Billing webhook service (billing/02).
 *
 * Owns `POST /api/v1/stripe/webhooks` dispatch: verify the Stripe signature,
 * insert the event id into `stripe_events` FIRST (idempotency — a unique
 * violation means Stripe retried an already-handled event → return
 * `duplicate: true` without re-dispatching), then route by event type.
 *
 * Dispatch table (TECH_PLAN §5.2):
 * - `payment_intent.succeeded` → commission invoice paid, dunning cleared
 * - `payment_intent.payment_failed` → invoice failed → dunning + ops alert
 * - `invoice.payment_succeeded|payment_failed` → flat-plan subscription
 *   dunning handling (Stripe Billing's own invoices)
 * - `payment_method.attached` → tenant billing-ready audit event
 * - `customer.subscription.updated|deleted` → audit event
 * - anything else → logged audit event, 200 (never 500-retry loops)
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import type { AppDb } from '../../db/client';
import { stripeEvents } from '../../db/schema';
import { HttpError, ErrorCodes } from '../../middleware/errors';
import type { BillingAuditService } from './billing-audit.service';
import type { CommissionService } from './commission.service';
import type { FlatPlanService } from './flat-plan.service';
import type { NormalizedStripeEvent, StripeService } from './stripe.service';

export interface StripeWebhookResult {
  readonly received: boolean;
  readonly duplicate: boolean;
}

export interface BillingWebhookService {
  handleWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<StripeWebhookResult>;
}

export interface BillingWebhookServiceDeps {
  readonly db: AppDb;
  readonly stripe: StripeService;
  readonly audit: BillingAuditService;
  readonly commission: CommissionService;
  readonly flatPlan: FlatPlanService;
}

export function createBillingWebhookService(
  deps: BillingWebhookServiceDeps,
): BillingWebhookService {
  const { db, stripe, audit, commission, flatPlan } = deps;

  async function tryClaimEvent(event: NormalizedStripeEvent): Promise<boolean> {
    try {
      await db
        .insert(stripeEvents)
        .values({ eventId: event.id, type: event.type });
      return true;
    } catch (error) {
      // Unique violation on event_id = already handled (Stripe retry).
      // Drizzle wraps the PG error, so walk the cause chain.
      let current: unknown = error;
      while (current instanceof Error) {
        if (/unique|duplicate/i.test(current.message)) {
          return false;
        }
        current = current.cause;
      }
      throw error;
    }
  }

  async function tenantKeyFor(
    event: NormalizedStripeEvent,
  ): Promise<string | null> {
    if (!event.customerId) return null;
    return stripe.getTenantKeyByCustomerId(event.customerId);
  }

  /**
   * A stray event for the inactive billing model (e.g. a payment_intent
   * event while BILLING_MODEL=flat) must not 500 — Stripe would retry
   * forever. Audit it and move on.
   */
  async function tolerateModelMismatch(
    event: NormalizedStripeEvent,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === ErrorCodes.BILLING_MODEL_MISMATCH
      ) {
        await audit.append({
          tenantKey: null,
          eventType: 'webhook.model_mismatch',
          entityType: 'stripe_event',
          entityId: event.id,
          payload: { stripeType: event.type },
        });
        return;
      }
      throw error;
    }
  }

  return {
    async handleWebhook(
      rawBody: Buffer,
      signature: string | undefined,
    ): Promise<StripeWebhookResult> {
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Stripe webhook requires the raw request body',
        );
      }
      // 401 on a bad signature — verifyWebhook never throws 500 for this.
      const event = stripe.verifyWebhook(rawBody, signature ?? '');

      const claimed = await tryClaimEvent(event);
      if (!claimed) {
        return { received: true, duplicate: true };
      }

      const tenantKey = await tenantKeyFor(event);
      await audit.append({
        tenantKey,
        eventType: 'webhook.received',
        entityType: 'stripe_event',
        entityId: event.id,
        payload: { stripeType: event.type },
      });

      switch (event.type) {
        case 'payment_intent.succeeded':
          if (event.paymentIntentId) {
            const piId = event.paymentIntentId;
            await tolerateModelMismatch(event, () =>
              commission.markPaidByPaymentIntent(piId),
            );
          }
          break;
        case 'payment_intent.payment_failed':
          if (event.paymentIntentId) {
            const piId = event.paymentIntentId;
            await tolerateModelMismatch(event, () =>
              commission.markFailedByPaymentIntent(piId),
            );
          }
          break;
        case 'invoice.payment_succeeded':
          if (event.invoiceId) {
            await flatPlan.handleInvoicePaymentSucceeded({
              invoiceId: event.invoiceId,
              subscriptionId: event.subscriptionId,
              tenantKey: tenantKey ?? undefined,
            });
          }
          break;
        case 'invoice.payment_failed':
          if (event.invoiceId) {
            await flatPlan.handleInvoicePaymentFailed({
              invoiceId: event.invoiceId,
              subscriptionId: event.subscriptionId,
              customerId: event.customerId,
              tenantKey: tenantKey ?? undefined,
            });
          }
          break;
        case 'payment_method.attached':
          await audit.append({
            tenantKey,
            eventType: 'payment_method.attached',
            entityType: 'stripe_payment_method',
            entityId: event.paymentMethodId ?? 'unknown',
            payload: { customerId: event.customerId ?? null },
          });
          break;
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await audit.append({
            tenantKey,
            eventType: event.type,
            entityType: 'stripe_subscription',
            entityId: event.subscriptionId ?? 'unknown',
            payload: { customerId: event.customerId ?? null },
          });
          break;
        default:
          // Unhandled types → logged, 200. Never 500-retry loops.
          await audit.append({
            tenantKey,
            eventType: 'webhook.unhandled',
            entityType: 'stripe_event',
            entityId: event.id,
            payload: { stripeType: event.type },
          });
          break;
      }

      return { received: true, duplicate: false };
    },
  };
}
