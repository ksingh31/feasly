/**
 * Billing webhook service (billing/02).
 *
 * Owns `POST /api/v1/stripe/webhooks` dispatch: verify the Stripe signature,
 * record the event id in `stripe_events` FIRST, route by event type, and
 * stamp `processed_at` only after the handler completes (#711). A
 * redelivery of a PROCESSED event returns `duplicate: true` without
 * re-dispatching; a redelivery of a claimed-but-unprocessed event (the
 * handler threw, Stripe got a non-2xx and retried) re-runs the handler —
 * every handler is idempotent on terminal status, so this never
 * double-applies.
 *
 * Dispatch table (TECH_PLAN §5.2):
 * - `payment_intent.succeeded` → commission invoice paid, dunning cleared
 * - `payment_intent.payment_failed` → invoice failed → dunning + ops alert
 * - `payment_intent.requires_action` → invoice action_required → builder
 *   "confirm this payment" email (#712)
 * - `payment_intent.processing` → audited; the invoice stays finalized
 *   until the terminal event (or #711 reconciliation) settles it (#712)
 * - a `payment_intent.*` event that beats the charge call's own response
 *   (its metadata names an invoice whose charge is still being recorded)
 *   → non-2xx so the provider redelivers it (#712)
 * - `invoice.payment_succeeded|payment_failed` → flat-plan subscription
 *   dunning handling (Stripe Billing's own invoices)
 * - `payment_method.attached` → tenant billing-ready audit event
 * - #716 card lifecycle (`setup_intent.succeeded|setup_failed`,
 *   `payment_method.detached|updated|automatically_updated`,
 *   `customer.deleted`) → CommissionCardService.handleCardEvent (the saved
 *   card becomes the default and replaces the old one; a deleted customer
 *   is forgotten)
 * - `customer.subscription.updated|deleted` → audit event
 * - anything else → logged audit event, 200 (never 500-retry loops)
 * - `payment_intent.*` for a PaymentIntent no invoice owns → audited as
 *   `webhook.orphan_payment_intent`, one ops alert, 200 (#711)
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { stripeEvents } from '../../db/schema';
import { HttpError, ErrorCodes } from '../../middleware/errors';
import { AUTHENTICATION_REQUIRED_CODE } from '../../lib/charge-outcome';
import type { EmailService } from '../email/email.service';
import { ensureOpsAlertDelivered } from '../ops-alerts.service';
import type { BillingAuditService } from './billing-audit.service';
import {
  isCardWebhookEvent,
  type CommissionCardService,
} from './commission-card.service';
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
  /** #716 card lifecycle events. Absent (legacy tests) = audited only. */
  readonly commissionCard?: Pick<CommissionCardService, 'handleCardEvent'>;
  /** Ops alert delivery for orphan PaymentIntents (#711). */
  readonly email: Pick<EmailService, 'sendOpsAlert'>;
  readonly opsInbox: string;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
  /** Warning sink for best-effort alert failures. Defaults to console.warn. */
  readonly logWarning?: (message: string) => void;
}

/**
 * Result of recording an event id:
 * - `new`: first delivery — dispatch.
 * - `unprocessed`: recorded earlier but the handler never completed — re-run.
 * - `processed`: fully handled earlier — duplicate, no-op.
 */
type ClaimOutcome = 'new' | 'unprocessed' | 'processed';

export function createBillingWebhookService(
  deps: BillingWebhookServiceDeps,
): BillingWebhookService {
  const { db, stripe, audit, commission, flatPlan, email, opsInbox } = deps;
  const now = deps.now ?? (() => new Date());
  const logWarning =
    deps.logWarning ?? ((message: string) => console.warn(message));

  async function claimEvent(
    event: NormalizedStripeEvent,
  ): Promise<ClaimOutcome> {
    const inserted = await db
      .insert(stripeEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeEvents.eventId })
      .returning({ eventId: stripeEvents.eventId });
    if (inserted.length > 0) return 'new';
    const existing = await db.query.stripeEvents.findFirst({
      where: eq(stripeEvents.eventId, event.id),
      columns: { processedAt: true },
    });
    return existing?.processedAt ? 'processed' : 'unprocessed';
  }

  async function markProcessed(eventId: string): Promise<void> {
    await db
      .update(stripeEvents)
      .set({ processedAt: now() })
      .where(eq(stripeEvents.eventId, eventId));
  }

  /**
   * #711: a `payment_intent.*` event for a PaymentIntent no commission
   * invoice owns (created outside Feasly, or an invoice since removed) must
   * not 404 — Stripe would retry for days. Audit it, alert ops once, 200.
   */
  async function tolerateOrphanPaymentIntent(
    event: NormalizedStripeEvent,
    paymentIntentId: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status === 404 &&
        error.code === ErrorCodes.NOT_FOUND
      ) {
        await audit.append({
          tenantKey: null,
          eventType: 'webhook.orphan_payment_intent',
          entityType: 'stripe_event',
          entityId: event.id,
          payload: { stripeType: event.type, paymentIntentId },
        });
        await alertOrphan(event, paymentIntentId);
        return;
      }
      throw error;
    }
  }

  /**
   * Best-effort: the event is acknowledged either way. Throwing here would
   * leave the event unprocessed, and Stripe's redelivery would write a
   * second orphan audit row.
   */
  async function alertOrphan(
    event: NormalizedStripeEvent,
    paymentIntentId: string,
  ): Promise<void> {
    const title = 'Stripe webhook for an unknown payment';
    try {
      const delivery = await email.sendOpsAlert({
        to: opsInbox,
        title,
        summary:
          `Stripe sent ${event.type} (event ${event.id}) for payment intent ` +
          `${paymentIntentId}, which no Feasly invoice owns. The event was ` +
          `acknowledged and logged. Check the payment in the Stripe dashboard.`,
        firedAt: now(),
      });
      ensureOpsAlertDelivered(delivery, title, logWarning);
    } catch (error) {
      logWarning(
        `stripe-webhook: orphan payment intent alert not delivered ` +
          `(${error instanceof Error ? error.message : 'unknown error'})`,
      );
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

      const claim = await claimEvent(event);
      if (claim === 'processed') {
        return { received: true, duplicate: true };
      }

      const tenantKey = await tenantKeyFor(event);
      await audit.append({
        tenantKey,
        eventType: 'webhook.received',
        entityType: 'stripe_event',
        entityId: event.id,
        payload:
          claim === 'unprocessed'
            ? { stripeType: event.type, redelivery: true }
            : { stripeType: event.type },
      });

      switch (event.type) {
        case 'payment_intent.succeeded':
          if (event.paymentIntentId) {
            const piId = event.paymentIntentId;
            await tolerateModelMismatch(event, () =>
              tolerateOrphanPaymentIntent(event, piId, () =>
                commission.markPaidByPaymentIntent(piId, {
                  invoiceIdHint: event.commissionInvoiceId,
                  chargeAttemptHint: event.chargeAttempt,
                }),
              ),
            );
          }
          break;
        case 'payment_intent.payment_failed':
          if (event.paymentIntentId) {
            const piId = event.paymentIntentId;
            // #712: real Stripe reports an off-session 3DS demand as
            // payment_failed + code authentication_required (it never sends
            // requires_action for it). That is recoverable on-session, so it
            // takes the action-required path — a no-op when the charge step
            // already moved the invoice to action_required.
            if (event.errorCode === AUTHENTICATION_REQUIRED_CODE) {
              await tolerateModelMismatch(event, () =>
                tolerateOrphanPaymentIntent(event, piId, () =>
                  commission.markActionRequiredByPaymentIntent(piId, {
                    invoiceIdHint: event.commissionInvoiceId,
                    chargeAttemptHint: event.chargeAttempt,
                  }),
                ),
              );
              break;
            }
            await tolerateModelMismatch(event, () =>
              tolerateOrphanPaymentIntent(event, piId, () =>
                commission.markFailedByPaymentIntent(piId, event.failureMessage, {
                  invoiceIdHint: event.commissionInvoiceId,
                  chargeAttemptHint: event.chargeAttempt,
                  ...(event.declineCode ? { declineCode: event.declineCode } : {}),
                }),
              ),
            );
          }
          break;
        case 'payment_intent.requires_action':
          if (event.paymentIntentId) {
            const piId = event.paymentIntentId;
            await tolerateModelMismatch(event, () =>
              tolerateOrphanPaymentIntent(event, piId, () =>
                commission.markActionRequiredByPaymentIntent(piId, {
                  invoiceIdHint: event.commissionInvoiceId,
                  chargeAttemptHint: event.chargeAttempt,
                }),
              ),
            );
          }
          break;
        case 'payment_intent.processing':
          // In flight — nothing to settle yet. The terminal event (or the
          // #711 reconciliation pass) moves the invoice.
          await audit.append({
            tenantKey,
            eventType: 'webhook.payment_processing',
            entityType: 'stripe_event',
            entityId: event.id,
            payload: { paymentIntentId: event.paymentIntentId ?? null },
          });
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
          if (isCardWebhookEvent(event.type) && deps.commissionCard) {
            await deps.commissionCard.handleCardEvent(event, tenantKey);
            break;
          }
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

      // Only now is the event done: a throw above leaves processed_at null
      // so Stripe's redelivery re-runs the handler (#711).
      await markProcessed(event.id);
      return { received: true, duplicate: false };
    },
  };
}
