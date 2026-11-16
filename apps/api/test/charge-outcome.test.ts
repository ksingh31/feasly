/**
 * Charge-outcome classification (#712) — pure mapping from what a payment
 * provider reported about an off-session charge to the engine's outcome.
 */
import { describe, expect, it } from 'vitest';
import { classifyChargeOutcome } from '../src/lib/charge-outcome';

describe('classifyChargeOutcome', () => {
  it.each([
    [{ status: 'succeeded' }, 'succeeded'],
    [{ status: 'processing' }, 'processing'],
    [{ status: 'requires_capture' }, 'processing'],
    [{ status: 'something_new' }, 'processing'],
    [{ status: 'requires_action' }, 'requires_action'],
    [{ status: 'requires_confirmation' }, 'requires_action'],
    [{ status: 'requires_payment_method', errorCode: 'card_declined' }, 'failed'],
    [{ status: 'requires_payment_method' }, 'failed'],
    [{ status: 'canceled' }, 'failed'],
    // Stripe: an off-session confirm needing 3DS is rejected with
    // authentication_required and leaves the intent requires_payment_method.
    [{ status: 'requires_payment_method', errorCode: 'authentication_required' }, 'requires_action'],
  ] as const)('%j → %s', (report, expected) => {
    expect(classifyChargeOutcome(report)).toBe(expected);
  });
});
