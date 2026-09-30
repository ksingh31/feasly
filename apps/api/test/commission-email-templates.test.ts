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
  brandName: 'Feasly',
};

describe('commission-invoice-ready template (BILL-04)', () => {
  it('renders reference, commission, contract value, and review deadline', () => {
    const due = new Date('2026-10-01T12:00:00.000Z');
    const rendered = renderCommissionInvoiceReadyEmail(CTX, {
      invoiceRef: 'INV-2026-001',
      commissionCents: 500_000,
      contractValueCents: 50_000_000,
      currency: 'CAD',
      commissionRatePercent: 1,
      reviewDueAt: due,
    });

    expect(rendered.subject).toContain('commission invoice');
    expect(rendered.html).toContain('INV-2026-001');
    // 1% commission: $5,000.00
    expect(rendered.html).toContain('$5,000.00');
    // The effective rate threads into the label — no hardcoded percent.
    expect(rendered.html).toContain('Commission (1%)');
    expect(rendered.text).toContain('Commission (1%): $5,000.00');
    // Contract value excluding land: $500,000.00
    expect(rendered.html).toContain('$500,000.00');
    expect(rendered.html).toContain('excl. land');
    // Review deadline rendered as a day-level date (en-CA short month).
    expect(rendered.html).toContain('Oct 1, 2026');
    expect(rendered.text).toContain('INV-2026-001');
    expect(rendered.text).toContain('$5,000.00');
    // Transactional: no unsubscribe footer.
    expect(rendered.html).not.toContain('unsubscribe');
  });
});

describe('commission-payment-received template (BILL-04)', () => {
  it('renders receipt details and invoice reference', () => {
    const rendered = renderCommissionPaymentReceivedEmail(CTX, {
      invoiceRef: 'INV-2026-001',
      commissionCents: 500_000,
      currency: 'CAD',
      paidAt: new Date('2026-09-28T12:00:00.000Z'),
    });

    expect(rendered.subject).toContain('Payment received');
    expect(rendered.html).toContain('INV-2026-001');
    expect(rendered.html).toContain('$5,000.00');
    expect(rendered.html).toContain('Sep 28, 2026');
    expect(rendered.text).toContain('INV-2026-001');
  });
});

describe('commission-payment-failed template (BILL-04)', () => {
  it('renders the card-update CTA and the 7-day window', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, {
      invoiceRef: 'INV-2026-001',
      commissionCents: 500_000,
      currency: 'CAD',
      updateWithinDays: 7,
    });

    expect(rendered.subject).toContain('INV-2026-001');
    expect(rendered.html).toContain('INV-2026-001');
    expect(rendered.html).toContain('$5,000.00');
    expect(rendered.html).toContain('Update card');
    expect(rendered.html).toContain('7 days');
    expect(rendered.text).toContain('7 days');
  });
});
