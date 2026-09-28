/**
 * SDK-client regression tests for the off-session charge path (BILL-02
 * pre-merge review).
 *
 * A card attached via SetupIntent is NOT automatically the customer's
 * default payment method, so creating an off-session PaymentIntent with
 * only `customer` fails when no default is set. The SDK client must
 * resolve an explicit payment method (newest card first) and pass it as
 * `payment_method`.
 *
 * The Stripe SDK constructor is mocked — no network, no real keys.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  paymentMethodsList: vi.fn(),
  paymentIntentsCreate: vi.fn(),
}));

vi.mock('stripe', () => {
  class FakeStripe {
    paymentMethods = { list: mocks.paymentMethodsList };
    paymentIntents = { create: mocks.paymentIntentsCreate };
    constructor() {}
  }
  return { default: FakeStripe };
});

import { createStripeSdkClient } from '../src/services/billing/stripe.service';
import { ErrorCodes } from '../src/middleware/errors';

const INPUT = {
  amountCents: 1000,
  currency: 'CAD',
  customerId: 'cus_test_123',
  description: 'Feasly commission 1% — invoice test',
};

beforeEach(() => {
  mocks.paymentMethodsList.mockReset();
  mocks.paymentIntentsCreate.mockReset();
});

describe('createStripeSdkClient.createOffSessionPaymentIntent', () => {
  it('passes the newest saved card as payment_method (no reliance on customer default)', async () => {
    mocks.paymentMethodsList.mockResolvedValue({
      data: [{ id: 'pm_newest_1' }, { id: 'pm_older_2' }],
    });
    mocks.paymentIntentsCreate.mockResolvedValue({
      id: 'pi_test_1',
      status: 'succeeded',
    });

    const client = createStripeSdkClient('sk_test_fake');
    const result = await client.createOffSessionPaymentIntent(
      INPUT,
      'idem-key-1',
    );

    expect(result).toEqual({ id: 'pi_test_1', status: 'succeeded' });
    expect(mocks.paymentMethodsList).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      type: 'card',
      limit: 1,
    });
    expect(mocks.paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test_123',
        payment_method: 'pm_newest_1',
        off_session: true,
        confirm: true,
      }),
      { idempotencyKey: 'idem-key-1' },
    );
  });

  it('fails fast with BILLING_NOT_CONFIGURED when the customer has no cards', async () => {
    mocks.paymentMethodsList.mockResolvedValue({ data: [] });

    const client = createStripeSdkClient('sk_test_fake');
    const err = await client
      .createOffSessionPaymentIntent(INPUT, 'idem-key-2')
      .catch((e) => e);

    expect(err.code).toBe(ErrorCodes.BILLING_NOT_CONFIGURED);
    expect(err.status).toBe(422);
    expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });
});
