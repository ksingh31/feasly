/**
 * #862 (API #715): which adjustment actions an invoice accepts, the refund
 * preview, and the audit events the drawer timeline adds.
 */
import { describe, expect, it } from 'vitest';
import type { AuditLogEntry } from '@feasly/contracts';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import {
  adjustmentTimeline,
  canCorrectContract,
  canRefundInvoice,
  canReversePayment,
  canVoidInvoice,
  centsToDollarInput,
  mergeTimelines,
  newRefundIdempotencyKey,
  refundNeedsReference,
  refundPreview,
  refundableCents,
} from './admin-invoice-view';

type Fields = Pick<
  BuilderCommissionInvoice,
  'status' | 'totalCents' | 'refundedCents' | 'manualPaymentMethod' | 'stripePaymentIntentId'
>;

const PAID_CARD: Fields = {
  status: 'paid',
  totalCents: 2_079_000,
  refundedCents: 0,
  manualPaymentMethod: null,
  stripePaymentIntentId: 'pi_1',
};

const STATUSES = ['draft', 'in_review', 'finalized', 'action_required', 'paid', 'failed', 'disputed', 'void'] as const;

function entry(action: string, payload: Record<string, unknown>, id = `billing:${action}`): AuditLogEntry {
  return {
    id,
    source: 'billing',
    occurredAt: '2026-11-20T12:00:00.000Z',
    actorEmail: 'ops@feasly.ca',
    action,
    entityType: 'invoice',
    entityId: 'inv-1',
    tenantKey: 'elite-craft',
    impersonation: false,
    payload,
  };
}

describe('adjustment rules (mirror the #715 API preconditions)', () => {
  it('void: draft, in review and failed only', () => {
    expect(STATUSES.filter((status) => canVoidInvoice({ status }))).toEqual(['draft', 'in_review', 'failed']);
  });

  it('correct contract: draft and in review only', () => {
    expect(STATUSES.filter((status) => canCorrectContract({ status }))).toEqual(['draft', 'in_review']);
  });

  it('refund: a paid invoice with something left to refund', () => {
    expect(STATUSES.filter((status) => canRefundInvoice({ ...PAID_CARD, status }))).toEqual(['paid']);
    expect(canRefundInvoice({ ...PAID_CARD, refundedCents: 1_000_000 })).toBe(true);
    expect(canRefundInvoice({ ...PAID_CARD, refundedCents: 2_079_000 })).toBe(false);
  });

  it('reverse payment: paid by hand with no refunds', () => {
    const manual = { ...PAID_CARD, manualPaymentMethod: 'cheque' as const, stripePaymentIntentId: null };
    expect(canReversePayment(manual)).toBe(true);
    expect(canReversePayment(PAID_CARD)).toBe(false);
    expect(canReversePayment({ ...manual, refundedCents: 100 })).toBe(false);
    expect(canReversePayment({ ...manual, status: 'failed' })).toBe(false);
  });

  it('a refund needs a reference unless the invoice was charged on Stripe', () => {
    expect(refundNeedsReference(PAID_CARD)).toBe(false);
    expect(refundNeedsReference({ ...PAID_CARD, manualPaymentMethod: 'e_transfer' })).toBe(true);
    expect(refundNeedsReference({ ...PAID_CARD, stripePaymentIntentId: null })).toBe(true);
  });
});

describe('refund preview', () => {
  it('shows the refunded total and the net left, in integer cents', () => {
    const invoice = { totalCents: 2_079_000, refundedCents: 79_000 };
    expect(refundableCents(invoice)).toBe(2_000_000);
    expect(refundPreview(invoice, 50_050)).toEqual({
      refundedBefore: 79_000,
      refundedAfter: 129_050,
      netBefore: 2_000_000,
      netAfter: 1_949_950,
    });
  });

  it('is null for no amount, zero, a fraction of a cent, or more than is left', () => {
    const invoice = { totalCents: 10_000, refundedCents: 4_000 };
    expect(refundPreview(invoice, null)).toBeNull();
    expect(refundPreview(invoice, 0)).toBeNull();
    expect(refundPreview(invoice, 10.5)).toBeNull();
    expect(refundPreview(invoice, 6_001)).toBeNull();
    expect(refundPreview(invoice, 6_000)?.netAfter).toBe(0);
  });

  it('treats a pre-#715 invoice (no refundedCents) as nothing refunded', () => {
    expect(refundableCents({ totalCents: 500 })).toBe(500);
  });

  it('formats cents for the amount field', () => {
    expect(centsToDollarInput(2_079_005)).toBe('20790.05');
    expect(centsToDollarInput(0)).toBe('0.00');
  });

  it('builds idempotency keys the API accepts, unique per call', () => {
    const a = newRefundIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_:-]{8,100}$/);
    expect(newRefundIdempotencyKey()).not.toBe(a);
  });
});

describe('adjustmentTimeline', () => {
  it('maps the four #715 events with readable details and the actor', () => {
    const events = adjustmentTimeline([
      entry('invoice.refunded', {
        refundId: 'rf-1',
        amountCents: 50_000,
        refundedCents: 50_000,
        method: 'stripe',
        reason: 'billing_error',
        stripeRefundId: 're_1',
      }),
      entry('invoice.voided', { from: 'in_review', reason: 'created_in_error', note: 'Test lead' }),
      entry('invoice.contract_corrected', {
        old: { contractValueCents: 100_000_000, totalCents: 1_050_000 },
        new: { contractValueCents: 90_000_000, totalCents: 945_000 },
        note: 'Typo',
      }),
      entry('invoice.payment_reversed', { reversedPaymentMethod: 'cheque', reversedReference: 'CHQ-1', reason: 'Bounced' }),
      entry('invoice.chargeback_opened', {}),
    ]);
    expect(events.map((e) => e.title)).toEqual(['Refunded', 'Voided', 'Contract corrected', 'Payment reversed']);
    expect(events[0]).toMatchObject({ id: 'invoice.refunded', actor: 'ops@feasly.ca' });
    expect(events[0].payload).toContain('Amount $500');
    expect(events[0].payload).toContain('Card refund (Stripe)');
    expect(events[0].payload).toContain('Billing error');
    expect(String(events[0].payload)).not.toContain('rf-1');
    expect(String(events[0].payload)).not.toContain('re_1');
    expect(events[1].payload).toContain('From In review');
    expect(events[1].payload).toContain('Created in error');
    expect(events[1].payload).toContain('Note Test lead');
    expect(events[2].payload).toContain('Previous contract value $1,000,000');
    expect(events[2].payload).toContain('New contract value $900,000');
    expect(events[2].payload).toContain('New total $9,450');
    expect(String(events[2].payload)).not.toContain('{');
    expect(events[3].payload).toContain('Reversed method Cheque');
    expect(events[3].payload).toContain('Reason Bounced');
    expect(events[3].tone).toBe('danger');
  });

  it('merges without repeating an event already in the dispute trail', () => {
    const extra = adjustmentTimeline([entry('invoice.refunded', { amountCents: 1 }, 'billing:ev-7')]);
    const merged = mergeTimelines([{ id: 'ev-7', at: '2026-11-20T12:00:00.000Z', title: 'Refunded' }], extra);
    expect(merged).toHaveLength(1);
    expect(mergeTimelines([{ id: 'created', at: '2026-11-01T00:00:00.000Z' }], extra)).toHaveLength(2);
  });
});
