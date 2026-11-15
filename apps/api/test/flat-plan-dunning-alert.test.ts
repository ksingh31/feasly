/**
 * Flat-plan dunning ops alert delivery handling (issue #573).
 *
 * `handleInvoicePaymentFailed` runs inside the Stripe webhook: throwing
 * fails the webhook and Stripe redelivers it, re-sending the alert. An
 * accepted-but-unconfirmed ACS send must therefore count as sent; only a
 * send the provider never accepted throws.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFlatPlanService } from '../src/services/billing/flat-plan.service';
import type { BillingAuditService } from '../src/services/billing/billing-audit.service';
import type { StripeService } from '../src/services/billing/stripe.service';
import type {
  EmailDelivery,
  EmailService,
} from '../src/services/email/email.service';
import { EmailProviderError } from '../src/services/email';

const BILLING = {
  model: 'flat' as const,
  commissionRate: 0.01,
  attributionWindowDays: 365,
  reportingSlaDays: 14,
  flatPlanName: 'Builder Standard',
  flatMonthlyCents: 30_000,
  flatCurrency: 'CAD',
  stripeSecretKey: 'sk_test_fake',
  stripeWebhookSecret: 'whsec_test',
  stripeFlatPriceId: undefined,
  isProduction: false,
};

function harness(delivery: EmailDelivery) {
  const warnings: string[] = [];
  const sendOpsAlert = vi.fn(async () => delivery);
  const service = createFlatPlanService({
    billing: BILLING,
    audit: { append: async () => undefined } as unknown as BillingAuditService,
    stripe: {} as unknown as StripeService,
    email: { sendOpsAlert } as unknown as EmailService,
    opsInbox: 'ops@example.com',
    now: () => new Date('2026-11-13T06:00:00Z'),
    logWarning: (m) => warnings.push(m),
  });
  return { service, sendOpsAlert, warnings };
}

describe('flat-plan dunning alert delivery (#573)', () => {
  it('does not throw for an accepted-but-unconfirmed send and logs a warning', async () => {
    const { service, sendOpsAlert, warnings } = harness({
      sent: false,
      provider: 'acs',
      failureReason: 'delivery polling timed out after 7000ms',
      emailError: 'delivery-failed',
      acceptedByProvider: true,
    });
    await expect(
      service.handleInvoicePaymentFailed({ invoiceId: 'in_1' }),
    ).resolves.toBeUndefined();
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/accepted by provider/);
  });

  it('throws when the provider never accepted the send', async () => {
    const { service, warnings } = harness({
      sent: false,
      provider: 'acs',
      failureReason: '503',
      emailError: 'delivery-failed',
    });
    await expect(
      service.handleInvoicePaymentFailed({ invoiceId: 'in_2' }),
    ).rejects.toBeInstanceOf(EmailProviderError);
    expect(warnings).toHaveLength(0);
  });
});
