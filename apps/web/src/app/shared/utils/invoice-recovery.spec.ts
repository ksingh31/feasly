import { describe, expect, it } from 'vitest';
import type { InvoiceRefund } from '@feasly/contracts';
import { invoiceRecoveryState, netPaidCents, visibleRefunds } from './invoice-recovery';

describe('invoiceRecoveryState (#872)', () => {
  it('is null for a pre-#719 invoice (fields absent)', () => {
    expect(invoiceRecoveryState({})).toBeNull();
  });

  it('is null when nothing was refunded and there is no chargeback', () => {
    expect(invoiceRecoveryState({ refundedCents: 0, chargebackStatus: null })).toBeNull();
  });

  it('shows a refund only when refundedCents > 0', () => {
    expect(invoiceRecoveryState({ refundedCents: 2500, chargebackStatus: null })).toEqual({
      refundedCents: 2500,
      chargebackStatus: null,
    });
  });

  it('shows the chargeback state without a refund', () => {
    expect(invoiceRecoveryState({ refundedCents: 0, chargebackStatus: 'open' })).toEqual({
      refundedCents: null,
      chargebackStatus: 'open',
    });
  });

  it('shows both together', () => {
    expect(invoiceRecoveryState({ refundedCents: 980000, chargebackStatus: 'lost' })).toEqual({
      refundedCents: 980000,
      chargebackStatus: 'lost',
    });
  });
});

describe('netPaidCents / visibleRefunds (#862)', () => {
  it('is the total minus the cumulative refund, never below 0', () => {
    expect(netPaidCents({ totalCents: 10_000, refundedCents: 2_500 })).toBe(7_500);
    expect(netPaidCents({ totalCents: 10_000 })).toBe(10_000);
    expect(netPaidCents({ totalCents: 10_000, refundedCents: 12_000 })).toBe(0);
  });

  it('leaves out failed refund attempts', () => {
    const row = (id: string, status: 'pending' | 'succeeded' | 'failed') => ({ id, status }) as unknown as InvoiceRefund;
    expect(visibleRefunds({ refunds: [row('a', 'succeeded'), row('b', 'failed'), row('c', 'pending')] }).map((r) => r.id)).toEqual([
      'a',
      'c',
    ]);
    expect(visibleRefunds({})).toEqual([]);
  });
});
