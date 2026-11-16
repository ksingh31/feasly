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
  renderCommissionPaymentActionRequiredEmail,
  renderCommissionInvoiceOverdueEmail,
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

  it('#873: the chargeback_lost variant says the payment was reversed, not declined', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, {
      invoiceRef: 'INV-2026-001',
      commissionCents: 500_000,
      currency: 'CAD',
      updateWithinDays: 7,
      reason: 'chargeback_lost',
    });
    expect(rendered.subject).toBe(
      'Your bank reversed a payment — invoice INV-2026-001 is unpaid again',
    );
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain('INV-2026-001');
      expect(body).toContain('$5,000.00');
      expect(body).toContain('chargeback');
      expect(body).toContain('still owed');
      expect(body).not.toContain('declined');
    }
    expect(rendered.html).toContain('https://app.feasly.example/builder/billing');
  });

  it('#977: with no automatic retry scheduled, the chargeback_lost variant asks for Pay now', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, {
      invoiceRef: 'INV-2026-001',
      commissionCents: 500_000,
      currency: 'CAD',
      updateWithinDays: 7,
      nextRetryAt: null,
      reason: 'chargeback_lost',
    });
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain('still owed');
      expect(body).toContain('Pay now');
      expect(body).not.toMatch(/collect the payment again/i);
    }
  });

  it('#977: with an automatic retry scheduled, the chargeback_lost variant says it will collect again', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, {
      invoiceRef: 'INV-2026-001',
      commissionCents: 500_000,
      currency: 'CAD',
      updateWithinDays: 7,
      nextRetryAt: new Date('2026-11-20T17:00:00Z'),
      reason: 'chargeback_lost',
    });
    expect(rendered.text).toContain("We'll collect the payment again");
    expect(rendered.text).not.toContain('Pay now');
  });
});

describe('commission-payment-failed dunning copy (#718)', () => {
  const base = {
    invoiceRef: 'INV-0718',
    commissionCents: 500_000,
    currency: 'CAD',
    updateWithinDays: 7,
  };

  it('names the next automatic retry date and the Pay now option', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, {
      ...base,
      nextRetryAt: new Date('2026-11-23T18:00:00.000Z'),
    });
    expect(rendered.subject).toContain('declined');
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain('try the charge again on');
      expect(body).toContain('2026');
      expect(body).toContain('Pay now');
      expect(body).not.toContain('7 days');
    }
  });

  it('sends a final notice once the retry budget is used up', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, {
      ...base,
      nextRetryAt: null,
      finalNotice: true,
    });
    expect(rendered.subject).toBe('Final notice: invoice INV-0718 is unpaid');
    expect(rendered.text).toContain("We won't try this charge again automatically.");
    // Pay now attempts share the budget — never claim an automatic attempt ran.
    expect(rendered.text).not.toContain('last automatic attempt');
    expect(rendered.html).toContain('Pay now');
    expect(rendered.text).not.toContain('try the charge again');
  });

  it('with no retry scheduled, asks for Pay now without promising a retry', () => {
    const rendered = renderCommissionPaymentFailedEmail(CTX, { ...base, nextRetryAt: null });
    expect(rendered.text).toContain('choose Pay now on your billing page');
    expect(rendered.text).not.toContain('retry the charge automatically');
  });
});

describe('commission-invoice-overdue template (#718)', () => {
  it('states the due date and amount and offers the card switch', () => {
    const rendered = renderCommissionInvoiceOverdueEmail(CTX, {
      invoiceRef: 'INV-0719',
      commissionCents: 500_000,
      currency: 'CAD',
      dueAt: new Date('2026-11-20T18:00:00.000Z'),
    });
    expect(rendered.subject).toBe('Invoice INV-0719 is past due');
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain('INV-0719');
      expect(body).toContain('$5,000.00');
      expect(body).toContain('2026');
      expect(body).toContain('https://app.feasly.example/builder/billing');
    }
    expect(rendered.text).toContain('switch this invoice to your card on file');
  });
});

describe('commission-payment-action-required template (#712)', () => {
  it('asks the builder to confirm with their bank and deep-links the invoice', () => {
    const rendered = renderCommissionPaymentActionRequiredEmail(CTX, {
      invoiceId: '00000000-0000-4000-8000-000000000042',
      invoiceRef: 'INV-0042',
      commissionCents: 500_000,
      currency: 'CAD',
    });
    expect(rendered.subject).toBe('Your bank needs you to confirm this payment — invoice INV-0042');
    expect(rendered.html).toContain('$5,000.00');
    expect(rendered.html).toContain('Confirm payment with your bank');
    expect(rendered.html).toContain('not declined');
    const url = 'https://app.feasly.example/builder/invoices?open=00000000-0000-4000-8000-000000000042';
    expect(rendered.html).toContain(url);
    expect(rendered.text).toContain(`Confirm payment: ${url}`);
  });

  it('shows the amount charged including tax', () => {
    const rendered = renderCommissionPaymentActionRequiredEmail(CTX, {
      invoiceId: 'inv-1',
      invoiceRef: 'INV-0043',
      commissionCents: 1_875_000,
      currency: 'CAD',
      tax: { label: 'GST', ratePercent: 5, taxCents: 93_750, totalCents: 1_968_750, registrationNumber: '123456789RT0001' },
    });
    expect(rendered.text).toContain('$19,687.50 CAD');
  });
});

describe('commission emails — GST (#714)', () => {
  const TAX = {
    label: 'GST',
    ratePercent: 5,
    taxCents: 93_750,
    totalCents: 1_968_750,
    registrationNumber: '123456789RT0001',
  };
  const due = new Date('2026-10-01T12:00:00.000Z');
  const readyInput = {
    invoiceRef: 'INV-0042',
    commissionCents: 1_875_000,
    contractValueCents: 125_000_000,
    currency: 'CAD',
    commissionRatePercent: 1.5,
    reviewDueAt: due,
  };

  it('invoice-ready shows the commission, GST line, total and registration number', () => {
    const r = renderCommissionInvoiceReadyEmail(CTX, { ...readyInput, tax: TAX });
    expect(r.html).toContain('$18,750.00');
    expect(r.html).toContain('GST (5%)');
    expect(r.html).toContain('$937.50 CAD');
    expect(r.html).toContain('$19,687.50 CAD');
    expect(r.html).toContain('123456789RT0001');
    expect(r.text).toContain('GST (5%): $937.50 CAD');
    expect(r.text).toContain('Total: $19,687.50 CAD');
    expect(r.text).toContain('GST registration: 123456789RT0001');
  });

  it('payment-received charges the total and shows the breakdown', () => {
    const r = renderCommissionPaymentReceivedEmail(CTX, {
      invoiceRef: 'INV-0042',
      commissionCents: 1_875_000,
      currency: 'CAD',
      paidAt: due,
      tax: TAX,
    });
    expect(r.text).toContain('Amount charged: $19,687.50 CAD');
    expect(r.text).toContain('Commission: $18,750.00 CAD');
    expect(r.text).toContain('GST (5%): $937.50 CAD');
  });

  it('payment-failed names the declined total', () => {
    const r = renderCommissionPaymentFailedEmail(CTX, {
      invoiceRef: 'INV-0042',
      commissionCents: 1_875_000,
      currency: 'CAD',
      updateWithinDays: 7,
      tax: TAX,
    });
    expect(r.text).toContain('$19,687.50 CAD');
  });

  it('AC2: without tax every email is identical to the pre-tax output', () => {
    const ready = renderCommissionInvoiceReadyEmail(CTX, readyInput);
    expect(ready.html).not.toContain('GST');
    expect(ready.text).not.toContain('Total');
    const paid = renderCommissionPaymentReceivedEmail(CTX, {
      invoiceRef: 'INV-0042',
      commissionCents: 1_875_000,
      currency: 'CAD',
      paidAt: due,
    });
    expect(paid.text).toContain('Amount charged: $18,750.00 CAD\nDate:');
  });
});
