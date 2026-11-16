import { describe, expect, it } from 'vitest';
import type { BillingEvent, DisputeDetailResponse } from '@feasly/contracts';
import {
  acceptConfirmOptions,
  chargebackSummaryItems,
  disputeAmountCents,
  disputeReasonLabel,
  disputeEvidenceItems,
  isChargeback,
  stripeDisputeUrl,
  disputeTechnicalIds,
  disputeSlaChip,
  disputeTimeline,
  humanisePayload,
  rejectConfirmOptions,
} from './admin-disputes-view';

const DETAIL: DisputeDetailResponse = {
  id: 'd1',
  invoiceId: 'inv-1',
  tenantKey: 'elite-craft',
  reason: 'Contract value reported twice',
  status: 'open',
  openedAt: '2026-09-25T12:00:00.000Z',
  slaDueAt: '2026-10-02T12:00:00.000Z',
  slaBreachedAt: null,
  commissionCents: 980000,
  currency: 'CAD',
  contractValueCents: 98000000,
  businessDaysRemaining: 4,
  breached: false,
  evidenceSnapshot: {
    invoiceId: 'inv-1',
    tenantKey: 'elite-craft',
    attributionId: 'attr-1',
    leadId: 'lead-1',
    contractValueCents: 98000000,
    commissionCents: 980000,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status: 'disputed',
    reviewDueAt: null,
    disputeReason: 'Contract value reported twice',
    invoiceCreatedAt: '2026-09-20T10:00:00.000Z',
    disputedAt: '2026-09-25T12:00:00.000Z',
  },
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  auditTrail: [],
};

function event(eventType: string, payload: Record<string, unknown> | null, id = eventType): BillingEvent {
  return {
    id,
    tenantKey: 'elite-craft',
    eventType,
    entityType: 'commission_invoice',
    entityId: 'inv-1',
    payload,
    createdAt: '2026-09-25T12:00:00.000Z',
  };
}

describe('disputeSlaChip (AC1)', () => {
  it('days left → neutral on-track chip', () => {
    expect(disputeSlaChip({ businessDaysRemaining: 4, breached: false })).toEqual({
      key: 'on_track',
      label: '4 days left',
    });
    expect(disputeSlaChip({ businessDaysRemaining: 1, breached: false }).label).toBe('1 day left');
  });

  it('zero days → due today (warning)', () => {
    expect(disputeSlaChip({ businessDaysRemaining: 0, breached: false })).toEqual({
      key: 'due_today',
      label: 'Due today',
    });
  });

  it('negative days → overdue (danger) with the day count', () => {
    expect(disputeSlaChip({ businessDaysRemaining: -1, breached: true })).toEqual({
      key: 'overdue',
      label: 'Overdue 1d',
    });
    expect(disputeSlaChip({ businessDaysRemaining: -3, breached: true }).label).toBe('Overdue 3d');
  });

  it('a server-breached dispute never reads as on track', () => {
    expect(disputeSlaChip({ businessDaysRemaining: 0, breached: true })).toEqual({
      key: 'overdue',
      label: 'Overdue 1d',
    });
  });
});

describe('humanisePayload', () => {
  it('formats money, rates, enums and dates instead of raw JSON', () => {
    const text = humanisePayload({
      contractValueCents: 98000000,
      commissionRatePercent: 1.5,
      status: 'in_review',
      slaDueAt: 'not-a-date',
    });
    expect(text).toBe('Contract value $980,000\nCommission rate 1.5%\nStatus In review\nSLA due —');
    expect(text).not.toContain('contractValueCents');
  });

  it('labels unknown keys in sentence case', () => {
    expect(humanisePayload({ someNewField: 'x' })).toBe('Some new field x');
  });

  it('never renders raw identifiers (#538 — they live in Technical IDs)', () => {
    expect(
      humanisePayload({ invoiceId: 'inv-1', refundId: 're_1', leadId: 'l-1', reason: 'Wrong amount' }),
    ).toBe('Reason Wrong amount');
  });

  it('is empty for a null payload', () => {
    expect(humanisePayload(null)).toBe('');
  });
});

describe('disputeTimeline', () => {
  it('maps audit rows to humanised timeline events', () => {
    const events = disputeTimeline([
      event('invoice.created', { contractValueCents: 98000000, commissionCents: 980000 }),
      event('dispute.opened', { reason: 'Wrong amount' }),
      event('invoice.status_changed', { status: 'void', from: 'paid' }),
      event('dispute.resolved', { outcome: 'accepted', resolvedBy: 'karan@feasly.ca' }),
      event('invoice.mystery_thing', null),
    ]);
    expect(events.map((e) => e.title)).toEqual([
      'Invoice created',
      'Dispute opened',
      'Invoice void',
      'Dispute accepted',
      'Invoice mystery thing',
    ]);
    expect(events[0].payload).toBe('Contract value $980,000\nCommission $9,800');
    expect(events[1].tone).toBe('warning');
    expect(events[3].actor).toBe('karan@feasly.ca');
    expect(events[4].payload).toBeUndefined();
  });
});

describe('disputeEvidenceItems', () => {
  it('formats the snapshot as a definition list with the 1% fallback rate', () => {
    const items = disputeEvidenceItems(DETAIL.evidenceSnapshot);
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.value]));
    expect(byLabel['Contract value (excl. land)']).toBe('$980,000');
    expect(byLabel['Commission (1%)']).toBe('$9,800');
    expect(byLabel['Review window ended']).toBe('—');
    expect(byLabel['Builder']).toBe('elite-craft');
    // #538: no raw ids in the evidence list.
    expect(Object.keys(byLabel)).not.toContain('Lead ID');
    expect(Object.keys(byLabel)).not.toContain('Attribution ID');
    expect(Object.keys(byLabel)).not.toContain('Payment intent');
  });
});

describe('disputeTechnicalIds (#538)', () => {
  it('lists dispute, invoice, lead and attribution ids; payment intent only when charged', () => {
    const ids = disputeTechnicalIds(DETAIL);
    expect(ids.map((i) => i.label)).toEqual(['Dispute ID', 'Invoice ID', 'Lead ID', 'Attribution ID']);
    expect(ids[1].value).toBe('inv-1');
    const charged = disputeTechnicalIds({
      ...DETAIL,
      evidenceSnapshot: { ...DETAIL.evidenceSnapshot, stripePaymentIntentId: 'pi_1' },
    });
    expect(charged.at(-1)).toEqual({ label: 'Payment intent', value: 'pi_1' });
  });
});

describe('confirm copy', () => {
  it('Accept states the void and the refund amount (AC2)', () => {
    const options = acceptConfirmOptions(DETAIL);
    expect(options.title).toBe('Accept dispute and void the elite-craft invoice?');
    expect(options.title).not.toContain('inv-1');
    expect(options.body).toContain('voids this $9,800 commission invoice for elite-craft');
    expect(options.body).toContain('$9,800 is refunded to the card first');
    expect(options.verb).toBe('Accept and void');
    expect(options.tone).toBe('danger');
  });

  it('Reject states the fresh review window', () => {
    const options = rejectConfirmOptions(DETAIL);
    expect(options.body).toContain('fresh 7-day window');
    expect(options.verb).toBe('Reject dispute');
  });
});

describe('chargeback helpers (#872)', () => {
  const CB: DisputeDetailResponse = {
    ...DETAIL,
    reason: 'fraudulent',
    source: 'chargeback',
    stripeDisputeId: 'dp_123',
    stripeReason: 'fraudulent',
    stripeStatus: 'needs_response',
    amountCents: 990000,
    evidenceDueAt: '2026-10-06T23:59:59.000Z',
    evidenceDaysRemaining: 3,
    outcome: null,
    livemode: true,
  };

  it('treats an absent source as a builder dispute', () => {
    expect(isChargeback(DETAIL)).toBe(false);
    expect(isChargeback({ source: 'builder' })).toBe(false);
    expect(isChargeback(CB)).toBe(true);
  });

  it('counts a chargeback down to the evidence deadline (calendar days)', () => {
    expect(disputeSlaChip(CB)).toEqual({ key: 'on_track', label: 'Evidence due in 3 days' });
    expect(disputeSlaChip({ ...CB, evidenceDaysRemaining: 1 }).label).toBe('Evidence due in 1 day');
    expect(disputeSlaChip({ ...CB, evidenceDaysRemaining: 0 })).toEqual({ key: 'due_today', label: 'Evidence due today' });
    expect(disputeSlaChip({ ...CB, evidenceDaysRemaining: -2, breached: true })).toEqual({
      key: 'overdue',
      label: 'Evidence overdue 2d',
    });
  });

  it('falls back to the business-day countdown when the evidence countdown is missing', () => {
    expect(disputeSlaChip({ ...CB, evidenceDaysRemaining: null }).label).toBe('4 days left');
  });

  it('builder disputes keep the business-day countdown', () => {
    expect(disputeSlaChip({ ...DETAIL, evidenceDaysRemaining: 9 }).label).toBe('4 days left');
  });

  it('amount + reason use the chargeback fields only for chargebacks', () => {
    expect(disputeAmountCents(CB)).toBe(990000);
    expect(disputeAmountCents(DETAIL)).toBe(980000);
    expect(disputeAmountCents({ ...CB, amountCents: null })).toBe(980000);
    expect(disputeReasonLabel(CB)).toBe('Fraudulent');
    expect(disputeReasonLabel(DETAIL)).toBe('Contract value reported twice');
  });

  it('builds the live / test Stripe dashboard URL from the configured base', () => {
    expect(stripeDisputeUrl(CB, 'https://dashboard.stripe.com')).toBe('https://dashboard.stripe.com/disputes/dp_123');
    expect(stripeDisputeUrl({ ...CB, livemode: false }, 'https://dashboard.stripe.com/')).toBe(
      'https://dashboard.stripe.com/test/disputes/dp_123',
    );
  });

  it('returns no URL for builder disputes, a missing id, unknown mode or no base', () => {
    expect(stripeDisputeUrl(DETAIL, 'https://dashboard.stripe.com')).toBeNull();
    expect(stripeDisputeUrl({ ...CB, stripeDisputeId: null }, 'https://dashboard.stripe.com')).toBeNull();
    expect(stripeDisputeUrl({ ...CB, livemode: null }, 'https://dashboard.stripe.com')).toBeNull();
    expect(stripeDisputeUrl(CB, '  ')).toBeNull();
  });

  it('encodes the dispute id into the path', () => {
    expect(stripeDisputeUrl({ ...CB, stripeDisputeId: 'dp/../x' }, 'https://d.example')).toBe(
      'https://d.example/disputes/dp%2F..%2Fx',
    );
  });

  it('summarises a chargeback with formatted server fields', () => {
    const items = chargebackSummaryItems({ ...CB, outcome: 'lost', livemode: false });
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.value]));
    expect(byLabel['Disputed amount']).toBe('$9,900');
    expect(byLabel['Commission']).toBe('$9,800');
    expect(byLabel['Stripe reason']).toBe('Fraudulent');
    expect(byLabel['Stripe status']).toBe('Needs response');
    expect(byLabel['Outcome']).toBe('Lost');
    expect(byLabel['Mode']).toBe('Stripe test mode');
  });

  it('titles the refund + chargeback audit rows and hides the Stripe dispute id', () => {
    const event = (eventType: string, payload: Record<string, unknown>): BillingEvent => ({
      id: eventType,
      tenantKey: 'elite-craft',
      eventType,
      entityType: 'commission_invoice',
      entityId: 'inv-1',
      payload,
      createdAt: '2026-10-01T12:00:00.000Z',
    });
    const timeline = disputeTimeline([
      event('invoice.refunded', { refundedCents: 2500 }),
      event('invoice.chargeback_opened', { stripeDisputeId: 'dp_123', amountCents: 990000, stripeReason: 'fraudulent' }),
      event('invoice.chargeback_closed', { outcome: 'won' }),
    ]);
    expect(timeline.map((t) => t.title)).toEqual(['Refunded', 'Chargeback opened', 'Chargeback closed']);
    expect(timeline[0].payload).toBe('Refunded $25');
    expect(timeline[1].tone).toBe('danger');
    expect(timeline[1].payload).toContain('Amount $9,900');
    expect(timeline[1].payload).toContain('Stripe reason Fraudulent');
    expect(timeline[1].payload).not.toContain('dp_123');
  });
});
