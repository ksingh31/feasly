import { describe, expect, it } from 'vitest';
import { invoiceRecoveryState } from './invoice-recovery';

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
