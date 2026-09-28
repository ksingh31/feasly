/**
 * Commission card-on-file service tests (billing/02, BILL-02).
 *
 * The service is the commission model's counterpart to the flat path's
 * card handling: ensureCustomer → createSetupIntent → getCard, all
 * model-gated to `commission` and fail-closed when Stripe is not
 * configured. Stripe is fully faked — no network, no real charges.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCommissionCardService,
  type CommissionCardServiceDeps,
} from '../src/services/billing/commission-card.service';
import type { BillingAuditService } from '../src/services/billing/billing-audit.service';
import type {
  CardSummary,
  StripeService,
} from '../src/services/billing/stripe.service';
import type { BillingConfig } from '../src/config';

interface FakeStripeState {
  customers: Map<string, string>;
  cards: Map<string, CardSummary[]>;
  configured: boolean;
}

function fakeStripe(state: FakeStripeState): StripeService {
  return {
    isConfigured: state.configured,
    testMode: true,
    createCustomer: vi.fn(async (input: { tenantKey: string }) => {
      const id = `cus_${input.tenantKey}`;
      state.customers.set(input.tenantKey, id);
      return { id };
    }),
    createSetupIntent: vi.fn(async (customerId: string) => ({
      id: `seti_${customerId}`,
      clientSecret: `secret_${customerId}`,
    })),
    listPaymentMethods: vi.fn(async (customerId: string) => {
      const tenantKey = [...state.customers.entries()].find(
        ([, id]) => id === customerId,
      )?.[0];
      return tenantKey ? (state.cards.get(tenantKey) ?? []) : [];
    }),
    createOffSessionPaymentIntent: vi.fn(),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    refundPaymentIntent: vi.fn(),
    verifyWebhook: vi.fn(),
    saveCustomerId: vi.fn(async (tenantKey: string, customerId: string) => {
      state.customers.set(tenantKey, customerId);
    }),
    getCustomerId: vi.fn(async (tenantKey: string) => {
      return state.customers.get(tenantKey) ?? null;
    }),
    getTenantKeyByCustomerId: vi.fn(),
  } as unknown as StripeService;
}

function makeDeps(opts?: {
  readonly model?: 'commission' | 'flat';
  readonly configured?: boolean;
  readonly customers?: Map<string, string>;
  readonly cards?: Map<string, CardSummary[]>;
}): { service: ReturnType<typeof createCommissionCardService>; state: FakeStripeState; audit: BillingAuditService; stripe: StripeService } {
  const state: FakeStripeState = {
    customers: opts?.customers ?? new Map(),
    cards: opts?.cards ?? new Map(),
    configured: opts?.configured ?? true,
  };
  const audit = {
    append: vi.fn(async (input: unknown) => ({ input })),
  } as unknown as BillingAuditService;
  const billing = {
    model: opts?.model ?? 'commission',
  } as BillingConfig;
  const stripe = fakeStripe(state);
  const deps: CommissionCardServiceDeps = {
    billing,
    audit,
    stripe,
  };
  return { service: createCommissionCardService(deps), state, audit, stripe };
}

describe('commission card-on-file (BILL-02)', () => {
  it('ensureCustomer creates and persists a Stripe customer, idempotently', async () => {
    const { service, state, audit, stripe } = makeDeps();
    const first = await service.ensureCustomer('elite-craft', 'b@x.com');
    expect(first).toBe('cus_elite-craft');
    const second = await service.ensureCustomer('elite-craft', 'b@x.com');
    expect(second).toBe(first);
    expect(audit.append).toHaveBeenCalledTimes(1);
    // Deterministic idempotency key guards the check-then-create race.
    expect(stripe.createCustomer).toHaveBeenCalledWith(
      { tenantKey: 'elite-craft', email: 'b@x.com' },
      'feasly-customer-elite-craft',
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantKey: 'elite-craft',
        eventType: 'customer.created',
        payload: { plan: 'commission' },
      }),
    );
    expect(state.customers.get('elite-craft')).toBe('cus_elite-craft');
  });

  it('createSetupIntent returns the client secret and audits the intent', async () => {
    const { service, audit } = makeDeps();
    await service.ensureCustomer('elite-craft');
    const result = await service.createSetupIntent('elite-craft');
    expect(result.setupIntentId).toBe('seti_cus_elite-craft');
    expect(result.clientSecret).toBe('secret_cus_elite-craft');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantKey: 'elite-craft',
        eventType: 'setup_intent.created',
      }),
    );
  });

  it('createSetupIntent 422s when the tenant has no customer yet', async () => {
    const { service } = makeDeps();
    await expect(service.createSetupIntent('elite-craft')).rejects.toMatchObject({
      status: 422,
    });
  });

  it('getCard returns hasCard: false with no customer or no cards', async () => {
    const { service } = makeDeps();
    await expect(service.getCard('elite-craft')).resolves.toEqual({
      hasCard: false,
    });
    await service.ensureCustomer('elite-craft');
    await expect(service.getCard('elite-craft')).resolves.toEqual({
      hasCard: false,
    });
  });

  it('getCard returns the saved card summary (never the PAN)', async () => {
    const cards = new Map<string, CardSummary[]>([
      [
        'elite-craft',
        [{ brand: 'visa', last4: '4242', expMonth: 12, expYear: 2028 }],
      ],
    ]);
    const { service } = makeDeps({ cards });
    await service.ensureCustomer('elite-craft');
    const status = await service.getCard('elite-craft');
    expect(status).toEqual({
      hasCard: true,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2028,
    });
    expect(JSON.stringify(status)).not.toContain('4242424242424242');
  });

  it('409s BILLING_MODEL_MISMATCH under the flat model', async () => {
    const { service } = makeDeps({ model: 'flat' });
    await expect(service.ensureCustomer('elite-craft')).rejects.toMatchObject({
      status: 409,
      code: 'BILLING_MODEL_MISMATCH',
    });
    await expect(service.createSetupIntent('elite-craft')).rejects.toMatchObject({
      status: 409,
      code: 'BILLING_MODEL_MISMATCH',
    });
    await expect(service.getCard('elite-craft')).rejects.toMatchObject({
      status: 409,
      code: 'BILLING_MODEL_MISMATCH',
    });
  });

  it('fail-closed: 422 on setup intent when Stripe is not configured', async () => {
    const { service } = makeDeps({ configured: false });
    await expect(service.ensureCustomer('elite-craft')).rejects.toMatchObject({
      status: 422,
    });
    await expect(service.createSetupIntent('elite-craft')).rejects.toMatchObject({
      status: 422,
    });
    await expect(service.getCard('elite-craft')).resolves.toEqual({
      hasCard: false,
    });
  });
});
