/**
 * BILL-04 builder billing email templates.
 *
 * Verifies the three commission templates render the required copy:
 * invoice reference, 1% commission amount, contract value excluding land,
 * review deadline (invoice-ready); receipt details (payment-received);
 * card-update CTA and 7-day window (payment-failed).
 *
 * Note: billing emails are transactional (no unsubscribe footer), and they
 * carry REAL billed amounts — the "no dollar figures in email copy" lint
 * rule applies to uncalibrated homeowner estimate figures, not to
 * transactional billing amounts.
 */
import { describe, expect, it } from 'vitest';
import {
  renderCommissionInvoiceReadyEmail,
  renderCommissionPaymentReceivedEmail,
  renderCommissionPaymentFailedEmail,
  type TemplateContext,
} from '../src/services/email/templates';

const CTX: TemplateContext = {
  appBaseUrl: 'https://app.feasly.example',
  unsubscribeBaseUrl: 'https://app.feasly.example/unsubscribe',
  appName: 'Feasly',
  supportEmail: 'support@feasly.example',
  builderName: 'Test Builder Inc',
};

describe('commission-invoice-ready template (BILL-04)', () => {
  it('renders reference, commission, contract value, and review deadline', () => {
    const due = new Date('2026-10-01T12:00:00.000Z');
    const rendered = renderCommissionInvoiceReadyEmail(CTX, {
      invoiceReference: 'INV-2026-001',
      commissionCents: 500_000,
      contractValueCents: 50_000_000,
      reviewDueAt: due,
      billingPortalUrl: 'https://app.feasly.example/builder/billing',
    });

    expect(rendered.subject).toContain('INV-2026-001');
    expect(rendered.html).toContain('INV-2026-001');
    // 1% commission: $5,000.00
    expect(rendered.html).toContain('$5,000.00');
    // Contract value excluding land: $500,000.00
    expect(rendered.html).toContain('$500,000.00');
    expect(rendered.html).toContain('excluding land');
    // Review deadline rendered as a day-level date.
    expect(rendered.html).toContain('October 1, 2026');
    expect(rendered.text).toContain('INV-2026-001');
    expect(rendered.text).toContain('$5,000.00');
    // Transactional: no unsubscribe footer.
    expect(rendered.html).not.toContain('unsubscribe');
  });
});

describe('commission-payment-received template (BILL-04)', () => {
  it('renders receipt details and invoice reference', () => {
    const rendered = renderCommissionPaymentReceivedEmail(CTX, {
      invoiceReference: 'INV-2026-001',
      commissionCents: 500_000,
      paidAt: new Date('2026-09-28T12:00:00.000Z'),
      cardBrand: 'visa',
      cardLast4: '4242',
      receiptUrl: 'https://app.feasly.example/builder/billing/receipt/1',
    });

    expect(rendered.subject).toContain('Payment received');
    expect(rendered.html).toContain('INV-2026-001');
    expect(rendered.html).toContain('$5,000.00');
    expect(rendered.html).toContain('4242');
    expect(rendered.html).toContain('September 28, 2026');
    expect(rendered.text).toContain('INV-2026-001');
  });
});

describe('commission-payment-failed template (BILL-04)', () => {
  it('renders the card-update CTA and the 7-day window', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, {
      invoiceReference: 'INV-2026-001',
      commissionCents: 500_000,
      failureReason: 'card_declined',
      updateCardUrl: 'https://app.feasly.example/builder/billing/card',
    });

    expect(rendered.subject).toContain('INV-2026-001');
    expect(rendered.html).toContain('INV-2026-001');
    expect(rendered.html).toContain('$5,000.00');
    expect(rendered.html).toContain('update your card');
    expect(rendered.html).toContain('7 days');
    expect(rendered.html).toContain(
      'https://app.feasly.example/builder/billing/card',
    );
    expect(rendered.text).toContain('7 days');
  });
});
