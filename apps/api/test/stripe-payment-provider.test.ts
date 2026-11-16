/**
 * StripePaymentProvider contract tests (#753) — the Stripe SDK client
 * honours the same PaymentProvider contract as the simulated provider.
 * The SDK is mocked with Stripe-shaped fixtures; no network, no keys.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  paymentMethodsList: vi.fn(),
  paymentMethodsDetach: vi.fn(),
  paymentIntentsCreate: vi.fn(),
  paymentIntentsRetrieve: vi.fn(),
  refundsCreate: vi.fn(),
  refundsList: vi.fn(),
  constructEvent: vi.fn(),
  customersCreate: vi.fn(),
  customersRetrieve: vi.fn(),
  customersUpdate: vi.fn(),
}));

vi.mock('stripe', () => {
  class FakeStripe {
    paymentMethods = { list: mocks.paymentMethodsList, detach: mocks.paymentMethodsDetach };
    paymentIntents = { create: mocks.paymentIntentsCreate, retrieve: mocks.paymentIntentsRetrieve };
    refunds = { create: mocks.refundsCreate, list: mocks.refundsList };
    webhooks = { constructEvent: mocks.constructEvent };
    customers = {
      create: mocks.customersCreate,
      retrieve: mocks.customersRetrieve,
      update: mocks.customersUpdate,
    };
    constructor() {}
  }
  return { default: FakeStripe };
});

import { createStripeSdkClient } from '../src/services/billing/stripe.service';
import { normalizeStripeEvent } from '../src/services/billing/payment-provider';

const INPUT = {
  amountCents: 1000,
  currency: 'CAD',
  customerId: 'cus_123',
  description: 'Feasly commission',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.paymentMethodsList.mockResolvedValue({
    data: [{ id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030 } }],
  });
  mocks.customersRetrieve.mockResolvedValue({
    id: 'cus_123',
    invoice_settings: { default_payment_method: null },
  });
});

describe('StripePaymentProvider (createStripeSdkClient)', () => {
  it('identifies itself as the stripe provider', () => {
    expect(createStripeSdkClient('sk_test_fake').name).toBe('stripe');
  });

  it('lists cards with their payment method id and display-safe fields', async () => {
    const cards = await createStripeSdkClient('sk_test_fake').listPaymentMethods('cus_123');
    expect(cards).toEqual([{ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030 }]);
  });

  it('detaches a payment method', async () => {
    mocks.paymentMethodsDetach.mockResolvedValue({ id: 'pm_1' });
    await expect(createStripeSdkClient('sk_test_fake').detachPaymentMethod('pm_1')).resolves.toEqual({
      id: 'pm_1',
    });
    expect(mocks.paymentMethodsDetach).toHaveBeenCalledWith('pm_1');
  });

  it('returns a declined off-session charge as a status instead of throwing', async () => {
    // Stripe's StripeCardError carries the PaymentIntent it created.
    mocks.paymentIntentsCreate.mockRejectedValue(
      Object.assign(new Error('Your card was declined.'), {
        type: 'StripeCardError',
        code: 'card_declined',
        payment_intent: { id: 'pi_declined', status: 'requires_payment_method' },
      }),
    );
    await expect(
      createStripeSdkClient('sk_test_fake').createOffSessionPaymentIntent(INPUT, 'k'),
    ).resolves.toEqual({
      id: 'pi_declined',
      status: 'requires_payment_method',
      errorCode: 'card_declined',
      failureMessage: 'Your card was declined.',
    });
  });

  it('returns the decline code and an authentication_required rejection with its PaymentIntent (#712)', async () => {
    const client = createStripeSdkClient('sk_test_fake');
    mocks.paymentIntentsCreate.mockRejectedValueOnce(
      Object.assign(new Error('Your card has insufficient funds.'), {
        type: 'StripeCardError',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        payment_intent: { id: 'pi_nofunds', status: 'requires_payment_method' },
      }),
    );
    await expect(client.createOffSessionPaymentIntent(INPUT, 'k')).resolves.toMatchObject({
      id: 'pi_nofunds',
      errorCode: 'card_declined',
      declineCode: 'insufficient_funds',
    });
    mocks.paymentIntentsCreate.mockRejectedValueOnce(
      Object.assign(new Error('This payment requires authentication.'), {
        type: 'StripeCardError',
        code: 'authentication_required',
        payment_intent: { id: 'pi_3ds', status: 'requires_payment_method' },
      }),
    );
    await expect(client.createOffSessionPaymentIntent(INPUT, 'k')).resolves.toMatchObject({
      id: 'pi_3ds',
      status: 'requires_payment_method',
      errorCode: 'authentication_required',
    });
  });

  it('passes PaymentIntent metadata through to Stripe (#712)', async () => {
    mocks.paymentIntentsCreate.mockResolvedValueOnce({ id: 'pi_ok', status: 'succeeded' });
    await createStripeSdkClient('sk_test_fake').createOffSessionPaymentIntent(
      { ...INPUT, metadata: { feasly_commission_invoice_id: 'inv-1' } },
      'k',
    );
    expect(mocks.paymentIntentsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: { feasly_commission_invoice_id: 'inv-1' } }),
      { idempotencyKey: 'k' },
    );
  });

  it('reads the client secret and the card for an on-session 3DS confirmation (#712)', async () => {
    mocks.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_3ds',
      status: 'requires_payment_method',
      client_secret: 'pi_3ds_secret_x',
      payment_method: null,
      last_payment_error: { payment_method: { id: 'pm_1' } },
    });
    await expect(
      createStripeSdkClient('sk_test_fake').getPaymentIntentConfirmation('pi_3ds'),
    ).resolves.toEqual({
      id: 'pi_3ds',
      status: 'requires_payment_method',
      clientSecret: 'pi_3ds_secret_x',
      paymentMethodId: 'pm_1',
    });
  });

  it('still throws non-card errors (network, auth, a card error with no PaymentIntent)', async () => {
    const client = createStripeSdkClient('sk_test_fake');
    mocks.paymentIntentsCreate.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { type: 'StripeConnectionError' }),
    );
    await expect(client.createOffSessionPaymentIntent(INPUT, 'k')).rejects.toThrow('boom');
    mocks.paymentIntentsCreate.mockRejectedValueOnce(
      Object.assign(new Error('declined'), { type: 'StripeCardError' }),
    );
    await expect(client.createOffSessionPaymentIntent(INPUT, 'k')).rejects.toThrow('declined');
  });

  it('charges the customer default card explicitly, with the statement descriptor suffix (#716)', async () => {
    mocks.customersRetrieve.mockResolvedValue({
      id: 'cus_123',
      invoice_settings: { default_payment_method: 'pm_default' },
    });
    mocks.paymentIntentsCreate.mockResolvedValue({ id: 'pi_1', status: 'succeeded' });
    await createStripeSdkClient('sk_test_fake').createOffSessionPaymentIntent(
      { ...INPUT, statementDescriptorSuffix: 'FEASLY COMMISSION' },
      'k',
    );
    expect(mocks.paymentMethodsList).not.toHaveBeenCalled();
    expect(mocks.paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_123',
        payment_method: 'pm_default',
        statement_descriptor_suffix: 'FEASLY COMMISSION',
      }),
      { idempotencyKey: 'k' },
    );
  });

  it('falls back to the newest card when no default is set, and omits an unset descriptor (#716)', async () => {
    mocks.paymentIntentsCreate.mockResolvedValue({ id: 'pi_1', status: 'succeeded' });
    await createStripeSdkClient('sk_test_fake').createOffSessionPaymentIntent(INPUT, 'k');
    const params = mocks.paymentIntentsCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['payment_method']).toBe('pm_1');
    expect(params).not.toHaveProperty('statement_descriptor_suffix');
  });

  it('reads and sets the default payment method (#716)', async () => {
    const client = createStripeSdkClient('sk_test_fake');
    expect(await client.getDefaultPaymentMethodId('cus_123')).toBeNull();
    mocks.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_123',
      invoice_settings: { default_payment_method: { id: 'pm_expanded' } },
    });
    expect(await client.getDefaultPaymentMethodId('cus_123')).toBe('pm_expanded');
    mocks.customersRetrieve.mockResolvedValueOnce({ id: 'cus_123', deleted: true });
    expect(await client.getDefaultPaymentMethodId('cus_123')).toBeNull();
    await client.setDefaultPaymentMethod('cus_123', 'pm_2');
    expect(mocks.customersUpdate).toHaveBeenCalledWith('cus_123', {
      invoice_settings: { default_payment_method: 'pm_2' },
    });
  });

  it('creates and updates customers with business name and builder id (#716)', async () => {
    mocks.customersCreate.mockResolvedValue({ id: 'cus_new' });
    const client = createStripeSdkClient('sk_test_fake');
    await client.createCustomer(
      { tenantKey: 'elite', email: 'a@b.test', name: 'Elite Craft Builders', builderId: 'b-1' },
      'idem',
    );
    expect(mocks.customersCreate).toHaveBeenCalledWith(
      {
        email: 'a@b.test',
        name: 'Elite Craft Builders',
        metadata: { feasly_tenant_key: 'elite', feasly_builder_id: 'b-1' },
      },
      { idempotencyKey: 'idem' },
    );
    await client.updateCustomer('cus_new', { tenantKey: 'elite', name: 'Elite Craft Ltd' });
    expect(mocks.customersUpdate).toHaveBeenCalledWith('cus_new', {
      name: 'Elite Craft Ltd',
      metadata: { feasly_tenant_key: 'elite' },
    });
  });

  it('refunds in full, or partially when an amount is given', async () => {
    mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'succeeded' });
    const client = createStripeSdkClient('sk_test_fake');
    await client.refundPaymentIntent('pi_1', 'k1');
    await client.refundPaymentIntent('pi_1', 'k2', 250);
    expect(mocks.refundsCreate).toHaveBeenNthCalledWith(1, { payment_intent: 'pi_1' }, { idempotencyKey: 'k1' });
    expect(mocks.refundsCreate).toHaveBeenNthCalledWith(
      2,
      { payment_intent: 'pi_1', amount: 250 },
      { idempotencyKey: 'k2' },
    );
  });

  it('#892: stores refund metadata on the Stripe refund', async () => {
    mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'pending' });
    const client = createStripeSdkClient('sk_test_fake');
    await expect(
      client.refundPaymentIntent('pi_1', 'k1', 250, { feasly_refund_id: 'row-1', feasly_invoice_id: 'inv-1' }),
    ).resolves.toEqual({ id: 're_1', status: 'pending' });
    expect(mocks.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', amount: 250, metadata: { feasly_refund_id: 'row-1', feasly_invoice_id: 'inv-1' } },
      { idempotencyKey: 'k1' },
    );
  });

  it('#892: finds a refund on the PaymentIntent by its feasly_refund_id metadata', async () => {
    // The SDK list is async-iterable (auto-pagination).
    async function* pages() {
      yield { id: 're_other', status: 'succeeded', metadata: {} };
      yield { id: 're_x', status: 'succeeded', metadata: { feasly_refund_id: 'row-2' } };
      yield { id: 're_match', status: 'pending', metadata: { feasly_refund_id: 'row-1' } };
    }
    mocks.refundsList.mockImplementation(() => pages());
    const client = createStripeSdkClient('sk_test_fake');
    await expect(client.findRefundByMetadata('pi_1', 'row-1')).resolves.toEqual({ id: 're_match', status: 'pending' });
    expect(mocks.refundsList).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
    await expect(client.findRefundByMetadata('pi_1', 'row-missing')).resolves.toBeNull();
  });

  it('normalizes verified webhook events with the shared normalizer', () => {
    mocks.constructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', customer: 'cus_1' } },
    });
    expect(createStripeSdkClient('sk_test_fake').constructWebhookEvent(Buffer.from('{}'), 'sig', 'whsec')).toEqual(
      expect.objectContaining({ id: 'evt_1', type: 'charge.refunded', paymentIntentId: 'pi_1', customerId: 'cus_1' }),
    );
  });
});

describe('normalizeStripeEvent', () => {
  it('reads the PaymentIntent of disputes and the decline message of failures', () => {
    expect(
      normalizeStripeEvent({
        id: 'evt_d',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_1', payment_intent: 'pi_9' } },
      }).paymentIntentId,
    ).toBe('pi_9');
    expect(
      normalizeStripeEvent({
        id: 'evt_f',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_2', last_payment_error: { message: 'Your card was declined.' } } },
      }),
    ).toMatchObject({ paymentIntentId: 'pi_2', failureMessage: 'Your card was declined.' });
  });

  it('reads the decline code and the invoice id from PaymentIntent metadata (#712)', () => {
    expect(
      normalizeStripeEvent({
        id: 'evt_g',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_3',
            metadata: { feasly_commission_invoice_id: 'inv-9', feasly_charge_attempt: '2' },
            last_payment_error: { message: 'Insufficient funds.', decline_code: 'insufficient_funds' },
          },
        },
      }),
    ).toMatchObject({
      paymentIntentId: 'pi_3',
      declineCode: 'insufficient_funds',
      commissionInvoiceId: 'inv-9',
      chargeAttempt: 2,
    });
    // #712: last_payment_error.code is read (authentication_required = 3DS).
    expect(
      normalizeStripeEvent({
        id: 'evt_sca',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_5',
            last_payment_error: { code: 'authentication_required', message: 'This payment requires authentication.' },
          },
        },
      }),
    ).toMatchObject({ paymentIntentId: 'pi_5', errorCode: 'authentication_required' });
    // Metadata on non-PaymentIntent objects is ignored.
    expect(
      normalizeStripeEvent({
        id: 'evt_h',
        type: 'charge.refunded',
        data: { object: { id: 'ch_1', payment_intent: 'pi_4', metadata: { feasly_commission_invoice_id: 'inv-9' } } },
      }).commissionInvoiceId,
    ).toBeUndefined();
  });

  it('reads card lifecycle events (#716)', () => {
    expect(
      normalizeStripeEvent({
        id: 'evt_s',
        type: 'setup_intent.succeeded',
        data: { object: { id: 'seti_1', customer: 'cus_1', payment_method: 'pm_1' } },
      }),
    ).toMatchObject({ customerId: 'cus_1', paymentMethodId: 'pm_1' });
    expect(
      normalizeStripeEvent({
        id: 'evt_sf',
        type: 'setup_intent.setup_failed',
        data: {
          object: {
            id: 'seti_2',
            customer: 'cus_1',
            payment_method: null,
            last_setup_error: { message: 'authentication failed' },
          },
        },
      }),
    ).toMatchObject({ customerId: 'cus_1', failureMessage: 'authentication failed' });
    // Stripe's detached event has customer: null; the owner is in
    // previous_attributes.
    expect(
      normalizeStripeEvent({
        id: 'evt_pd',
        type: 'payment_method.detached',
        data: {
          object: { id: 'pm_1', customer: null },
          previous_attributes: { customer: 'cus_1' },
        },
      }),
    ).toMatchObject({ customerId: 'cus_1', paymentMethodId: 'pm_1' });
    expect(
      normalizeStripeEvent({
        id: 'evt_cd',
        type: 'customer.deleted',
        data: { object: { id: 'cus_1', object: 'customer' } },
      }).customerId,
    ).toBe('cus_1');
    expect(
      normalizeStripeEvent({
        id: 'evt_sub',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', customer: 'cus_9' } },
      }),
    ).toMatchObject({ customerId: 'cus_9', subscriptionId: 'sub_1' });
  });
});
