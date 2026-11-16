/**
 * Simulated payments dev service (#753).
 *
 * The test-mode actions only the simulated provider can perform: confirm a
 * SetupIntent with a test card (stand-in for Stripe Elements), complete or
 * fail a 3D Secure challenge, and the admin dev panel's Stripe-dashboard
 * triggers (dispute, refund, delayed failure) against an invoice.
 *
 * When `PAYMENTS_PROVIDER=stripe` every method is a 404 — the endpoints do
 * not exist as far as a caller can tell. Builder actions are tenant-scoped:
 * an intent owned by another tenant's customer is a 404, never a 403, so ids
 * can't be probed.
 */
import type {
  SimulatedIntentResponse,
  SimulatedInvoiceEventKind,
  SimulatedInvoiceEventResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { BillingAuditService } from './billing-audit.service';
import type { CommissionService } from './commission.service';
import type { SimulatedPaymentProvider } from './simulated-payment.provider';
import type { StripeService } from './stripe.service';

export interface SimulatedPaymentsService {
  /** True when the simulated provider is active. */
  readonly enabled: boolean;
  confirmSetup(
    tenantKey: string,
    setupIntentId: string,
    cardNumber: string,
  ): Promise<SimulatedIntentResponse>;
  authenticate(
    tenantKey: string,
    intentId: string,
    outcome: 'complete' | 'fail',
  ): Promise<SimulatedIntentResponse>;
  fireInvoiceEvent(
    invoiceId: string,
    kind: SimulatedInvoiceEventKind,
    amountCents?: number,
  ): Promise<SimulatedInvoiceEventResponse>;
}

export interface SimulatedPaymentsServiceDeps {
  /** Null when PAYMENTS_PROVIDER=stripe. */
  readonly provider: SimulatedPaymentProvider | null;
  readonly stripe: Pick<StripeService, 'getCustomerId'>;
  readonly commission: Pick<CommissionService, 'getById'>;
  readonly audit: BillingAuditService;
}

function notFound(): HttpError {
  return new HttpError(404, ErrorCodes.NOT_FOUND, 'Not found.', false);
}

export function createSimulatedPaymentsService(
  deps: SimulatedPaymentsServiceDeps,
): SimulatedPaymentsService {
  const { stripe, commission, audit } = deps;

  function requireProvider(): SimulatedPaymentProvider {
    if (!deps.provider) throw notFound();
    return deps.provider;
  }

  async function requireOwnedIntent(
    provider: SimulatedPaymentProvider,
    tenantKey: string,
    intentId: string,
  ): Promise<void> {
    const [owner, tenantCustomer] = await Promise.all([
      provider.getIntentCustomerId(intentId),
      stripe.getCustomerId(tenantKey),
    ]);
    if (!owner || !tenantCustomer || owner !== tenantCustomer) {
      throw notFound();
    }
  }

  return {
    enabled: deps.provider !== null,

    async confirmSetup(tenantKey, setupIntentId, cardNumber) {
      const provider = requireProvider();
      await requireOwnedIntent(provider, tenantKey, setupIntentId);
      return provider.confirmSetupIntent(setupIntentId, cardNumber);
    },

    async authenticate(tenantKey, intentId, outcome) {
      const provider = requireProvider();
      await requireOwnedIntent(provider, tenantKey, intentId);
      return provider.authenticateIntent(intentId, outcome);
    },

    async fireInvoiceEvent(invoiceId, kind, amountCents) {
      const provider = requireProvider();
      const invoice = await commission.getById(invoiceId);
      const paymentIntentId = invoice.stripePaymentIntentId;
      if (!paymentIntentId) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" has not been charged yet — there is no payment to act on`,
        );
      }
      const { eventType } =
        kind === 'dispute'
          ? await provider.fireDispute(paymentIntentId)
          : kind === 'dispute_won' || kind === 'dispute_lost'
            ? await provider.fireDisputeClosed(
                paymentIntentId,
                kind === 'dispute_won' ? 'won' : 'lost',
              )
            : kind === 'refund'
              ? await provider.fireDashboardRefund(paymentIntentId, amountCents)
              : await provider.fireDelayedFailure(paymentIntentId);
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'simulated_payment.fired',
        entityType: 'commission_invoice',
        entityId: invoiceId,
        payload: {
          kind,
          paymentIntentId,
          eventType,
          ...(amountCents !== undefined ? { amountCents } : {}),
        },
      });
      return { invoiceId, paymentIntentId, kind, eventType };
    },
  };
}
