import { describe, expect, it } from 'vitest';
import type { BillingEvent, DisputeDetailResponse } from '@feasly/contracts';
import {
  acceptConfirmOptions,
  disputeEvidenceItems,
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
    expect(byLabel['Payment intent']).toBeNull();
  });
});

describe('confirm copy', () => {
  it('Accept states the void and the refund amount (AC2)', () => {
    const options = acceptConfirmOptions(DETAIL);
    expect(options.title).toContain('void invoice inv-1');
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
