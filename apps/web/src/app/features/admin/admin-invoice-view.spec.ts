import { describe, expect, it } from 'vitest';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import {
  auditTrailToTimeline,
  invoiceRateLabel,
  invoiceTimeline,
  isInvoiceActionable,
  methodConsequence,
  parseInvoiceRate,
  previewCommissionCents,
} from './admin-invoice-view';

describe('admin-invoice-view', () => {
  it('only unpaid invoices (in review / failed) are actionable', () => {
    expect(isInvoiceActionable('in_review')).toBe(true);
    expect(isInvoiceActionable('failed')).toBe(true);
    expect(isInvoiceActionable('paid')).toBe(false);
    expect(isInvoiceActionable('disputed')).toBe(false);
  });

  it('parses rates in (0, 10] only', () => {
    expect(parseInvoiceRate('1.5')).toBe(1.5);
    expect(parseInvoiceRate('10')).toBe(10);
    expect(parseInvoiceRate('0')).toBeNull();
    expect(parseInvoiceRate('10.01')).toBeNull();
    expect(parseInvoiceRate('abc')).toBeNull();
    expect(parseInvoiceRate('  ')).toBeNull();
  });

  it('labels rates without float noise', () => {
    expect(invoiceRateLabel(1.50000001)).toBe('1.5%');
    expect(invoiceRateLabel(null)).toBe('—');
  });

  it('previews the recalculated commission in integer cents', () => {
    expect(previewCommissionCents(198_000_000, 1.5)).toBe(2_970_000);
  });

  it('states what a method does to the auto-charge', () => {
    expect(methodConsequence('card')).toContain('armed');
    expect(methodConsequence('cheque')).toContain('paused');
  });

  it('builds milestones from the invoice dates', () => {
    const events = invoiceTimeline({
      createdAt: '2026-11-01T00:00:00Z',
      finalizedAt: '2026-11-08T00:00:00Z',
      paidAt: '2026-11-09T00:00:00Z',
      manualPaymentMethod: 'e_transfer',
    } as BuilderCommissionInvoice);
    expect(events.map((e) => e.title)).toEqual(['Invoice created', 'Finalized', 'Payment recorded (E-transfer)']);
  });

  it('humanises audit events and tones failures', () => {
    const [failed, unknown] = auditTrailToTimeline([
      { id: 'a', tenantKey: null, eventType: 'invoice_charge_failed', entityType: 'invoice', entityId: 'i', payload: { code: 'card_declined' }, createdAt: '2026-11-01T00:00:00Z' },
      { id: 'b', tenantKey: null, eventType: 'something_new', entityType: 'invoice', entityId: 'i', payload: null, createdAt: '2026-11-02T00:00:00Z' },
    ]);
    expect(failed).toMatchObject({ title: 'Charge failed', tone: 'danger', payload: { code: 'card_declined' } });
    expect(unknown.title).toBeUndefined();
    expect(unknown.type).toBe('something_new');
  });
});
