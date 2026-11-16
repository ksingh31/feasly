/**
 * Commission card lifecycle tests (#716) — one card per builder.
 *
 * - Saving a card makes it the customer's default and detaches the old one
 *   (setup_intent.succeeded webhook; getCard self-heals if it is late).
 * - removeCard detaches the card; 409 while an unpaid card invoice exists.
 * - expiresSoon / expired flags against the configured window.
 * - The Stripe customer gets the builder's business name / builder id.
 * - customer.deleted forgets the customer id.
 *
 * The payment provider is faked at the StripeService interface — no network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Builder } from '@feasly/contracts';
import type { BillingConfig } from '../src/config';
import type { BillingAuditService } from '../src/services/billing/billing-audit.service';
import {
  cardExpiryFlags,
  createCommissionCardService,
  isCardWebhookEvent,
} from '../src/services/billing/commission-card.service';
import type { InvoiceSummaryRecord } from '../src/services/billing/invoice-summary.store';
import type {
  CardSummary,
  CustomerDetails,
  NormalizedStripeEvent,
  StripeService,
} from '../src/services/billing/stripe.service';

const NOW = new Date('2026-11-16T12:00:00Z');
const TENANT = 'elite-craft';
const CUSTOMER = 'cus_elite';

interface World {
  customerByTenant: Map<string, string>;
  /** Cards per customer, newest first. */
  cards: Map<string, CardSummary[]>;
  defaults: Map<string, string | null>;
  customers: Map<string, CustomerDetails>;
  detached: string[];
}

function card(id: string, expMonth = 12, expYear = 2030): CardSummary {
  return { id, brand: 'visa', last4: id.slice(-4).padStart(4, '0'), expMonth, expYear };
}

function fakeStripe(world: World, configured = true): StripeService {
  return {
    isConfigured: configured,
    testMode: true,
    provider: 'simulated',
    createCustomer: vi.fn(async (input: CustomerDetails) => {
      world.customers.set(CUSTOMER, input);
      return { id: CUSTOMER };
    }),
    updateCustomer: vi.fn(async (id: string, input: CustomerDetails) => {
      world.customers.set(id, input);
    }),
    createSetupIntent: vi.fn(async () => ({ id: 'seti_1', clientSecret: 's' })),
    listPaymentMethods: vi.fn(async (id: string) => [...(world.cards.get(id) ?? [])]),
    getDefaultPaymentMethodId: vi.fn(async (id: string) => world.defaults.get(id) ?? null),
    setDefaultPaymentMethod: vi.fn(async (id: string, pm: string) => {
      world.defaults.set(id, pm);
    }),
    detachPaymentMethod: vi.fn(async (pm: string) => {
      world.detached.push(pm);
      for (const [cus, list] of world.cards) {
        world.cards.set(
          cus,
          list.filter((c) => c.id !== pm),
        );
        if (world.defaults.get(cus) === pm) world.defaults.set(cus, null);
      }
      return { id: pm };
    }),
    createOffSessionPaymentIntent: vi.fn(),
    getPaymentIntentConfirmation: vi.fn(),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    refundPaymentIntent: vi.fn(),
    retrievePaymentIntent: vi.fn(),
    verifyWebhook: vi.fn(),
    saveCustomerId: vi.fn(async (t: string, c: string) => {
      world.customerByTenant.set(t, c);
    }),
    getCustomerId: vi.fn(async (t: string) => world.customerByTenant.get(t) ?? null),
    getTenantKeyByCustomerId: vi.fn(async () => TENANT),
    clearCustomerId: vi.fn(async (c: string) => {
      for (const [t, id] of world.customerByTenant) {
        if (id === c) {
          world.customerByTenant.delete(t);
          return t;
        }
      }
      return null;
    }),
  } as StripeService;
}

const BUILDER: Builder = {
  id: 'b-1',
  tenantKey: TENANT,
  businessName: 'Elite Craft Builders',
  displayName: 'Elite Craft',
  email: 'billing@elite.test',
  phone: null,
  logoUrl: null,
  accentColor: null,
  allowedOrigins: [],
  plan: 'commission',
  status: 'active',
  settings: {},
  commissionRatePercent: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function invoice(
  overrides: Partial<InvoiceSummaryRecord>,
): InvoiceSummaryRecord {
  return {
    id: 'inv-1',
    leadId: 'lead-1',
    invoiceNumber: 'INV-0042',
    contractValueCents: 50_000_000,
    commissionCents: 500_000,
    currency: 'CAD',
    status: 'in_review',
    reviewDueAt: NOW,
    paymentMethod: 'card',
    ...overrides,
  };
}

function setup(opts?: {
  readonly cards?: CardSummary[];
  readonly defaultPm?: string | null;
  readonly withCustomer?: boolean;
  readonly invoices?: InvoiceSummaryRecord[];
  readonly model?: 'commission' | 'flat';
  readonly configured?: boolean;
}) {
  const world: World = {
    customerByTenant: new Map(
      opts?.withCustomer === false ? [] : [[TENANT, CUSTOMER]],
    ),
    cards: new Map([[CUSTOMER, opts?.cards ?? []]]),
    defaults: new Map([[CUSTOMER, opts?.defaultPm ?? null]]),
    customers: new Map(),
    detached: [],
  };
  const stripe = fakeStripe(world, opts?.configured ?? true);
  const audit = {
    append: vi.fn(async (input: unknown) => input),
  } as unknown as BillingAuditService;
  const logWarning = vi.fn();
  const service = createCommissionCardService({
    billing: {
      model: opts?.model ?? 'commission',
      cardExpiryWarningDays: 30,
    } as BillingConfig,
    audit,
    stripe,
    invoiceSummaries: {
      findByTenantKey: vi.fn(async () => opts?.invoices ?? []),
    },
    builders: { getByTenantKey: vi.fn(async () => BUILDER) },
    now: () => NOW,
    logWarning,
  });
  return { service, world, stripe, audit, logWarning };
}

function event(
  type: string,
  extra: Partial<NormalizedStripeEvent> = {},
): NormalizedStripeEvent {
  return { id: `evt_${type}`, type, customerId: CUSTOMER, ...extra };
}

function auditTypes(audit: BillingAuditService): string[] {
  return (audit.append as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => (c[0] as { eventType: string }).eventType,
  );
}

describe('cardExpiryFlags (#716)', () => {
  it('treats a card as valid through the last day of its expiry month', () => {
    // 11/2026 card on 2026-11-16: expires 2026-12-01 → 15 days away.
    expect(cardExpiryFlags({ expMonth: 11, expYear: 2026 }, NOW, 30)).toEqual({
      expiresSoon: true,
      expired: false,
    });
    // 12/2026: expires 2027-01-01 → 46 days away, outside a 30-day window.
    expect(cardExpiryFlags({ expMonth: 12, expYear: 2026 }, NOW, 30)).toEqual({
      expiresSoon: false,
      expired: false,
    });
    expect(cardExpiryFlags({ expMonth: 12, expYear: 2026 }, NOW, 60).expiresSoon).toBe(true);
    // 10/2026 ended on 2026-11-01.
    expect(cardExpiryFlags({ expMonth: 10, expYear: 2026 }, NOW, 30)).toEqual({
      expiresSoon: false,
      expired: true,
    });
  });

  it('never flags a card with unknown expiry', () => {
    expect(cardExpiryFlags({ expMonth: 0, expYear: 0 }, NOW, 30)).toEqual({
      expiresSoon: false,
      expired: false,
    });
  });
});

describe('getCard — one card per builder (#716)', () => {
  it('shows the newest card, makes it the default and detaches the old card', async () => {
    const { service, world, audit } = setup({
      cards: [card('pm_new2'), card('pm_old1')],
      defaultPm: 'pm_old1',
    });
    const status = await service.getCard(TENANT);
    expect(status).toMatchObject({ hasCard: true, last4: 'new2' });
    expect(world.defaults.get(CUSTOMER)).toBe('pm_new2');
    expect(world.detached).toEqual(['pm_old1']);
    expect(world.cards.get(CUSTOMER)?.map((c) => c.id)).toEqual(['pm_new2']);
    expect(auditTypes(audit)).toEqual([
      'payment_method.default_set',
      'payment_method.replaced',
    ]);
  });

  it('is a no-op when the single card is already the default', async () => {
    const { service, stripe, audit } = setup({
      cards: [card('pm_1')],
      defaultPm: 'pm_1',
    });
    await service.getCard(TENANT);
    expect(stripe.setDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(stripe.detachPaymentMethod).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('flags a card that expires within the window', async () => {
    const { service } = setup({ cards: [card('pm_1', 11, 2026)], defaultPm: 'pm_1' });
    await expect(service.getCard(TENANT)).resolves.toMatchObject({
      hasCard: true,
      expiresSoon: true,
      expired: false,
    });
  });

  it('a card detached in the Stripe dashboard reads as no card on the next load', async () => {
    const { service, world } = setup({ cards: [card('pm_1')], defaultPm: 'pm_1' });
    world.cards.set(CUSTOMER, []);
    await expect(service.getCard(TENANT)).resolves.toEqual({ hasCard: false });
  });

  it('still returns the card when the reconcile fails (best-effort, logged)', async () => {
    const { service, stripe, logWarning } = setup({
      cards: [card('pm_2'), card('pm_1')],
      defaultPm: 'pm_1',
    });
    (stripe.setDefaultPaymentMethod as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('stripe down'),
    );
    await expect(service.getCard(TENANT)).resolves.toMatchObject({
      hasCard: true,
      last4: 'pm_2',
    });
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('stripe down'));
  });
});

describe('removeCard (#716)', () => {
  it('detaches the card and audits the removal', async () => {
    const { service, world, audit } = setup({ cards: [card('pm_1')], defaultPm: 'pm_1' });
    await expect(service.removeCard(TENANT)).resolves.toEqual({ hasCard: false });
    expect(world.detached).toEqual(['pm_1']);
    expect(auditTypes(audit)).toEqual(['payment_method.removed']);
    await expect(service.getCard(TENANT)).resolves.toEqual({ hasCard: false });
  });

  it('is idempotent with no customer or no card', async () => {
    await expect(setup({ withCustomer: false }).service.removeCard(TENANT)).resolves.toEqual({
      hasCard: false,
    });
    const { service, stripe } = setup({ cards: [] });
    await expect(service.removeCard(TENANT)).resolves.toEqual({ hasCard: false });
    expect(stripe.detachPaymentMethod).not.toHaveBeenCalled();
  });

  it('409s with actionable copy while an unpaid invoice is set to charge the card', async () => {
    const { service, world } = setup({
      cards: [card('pm_1')],
      defaultPm: 'pm_1',
      invoices: [invoice({ status: 'in_review' })],
    });
    const err = await service.removeCard(TENANT).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect((err as Error).message).toContain('INV-0042');
    expect((err as Error).message).toContain('cheque, e-transfer or bank draft');
    expect(world.detached).toEqual([]);
  });

  it('counts several blocking invoices, including failed, finalized and disputed', async () => {
    const { service } = setup({
      cards: [card('pm_1')],
      invoices: [
        invoice({ id: 'a', status: 'failed' }),
        invoice({ id: 'b', status: 'finalized' }),
        invoice({ id: 'c', status: 'disputed' }),
      ],
    });
    await expect(service.removeCard(TENANT)).rejects.toThrow(/3 unpaid invoices/);
  });

  it('allows removal when unpaid invoices use a manual method or are settled', async () => {
    const { service, world } = setup({
      cards: [card('pm_1')],
      invoices: [
        invoice({ id: 'a', status: 'in_review', paymentMethod: 'cheque' }),
        invoice({ id: 'b', status: 'paid' }),
        invoice({ id: 'c', status: 'void' }),
      ],
    });
    await expect(service.removeCard(TENANT)).resolves.toEqual({ hasCard: false });
    expect(world.detached).toEqual(['pm_1']);
  });

  it('is model-gated and fail-closed', async () => {
    await expect(setup({ model: 'flat' }).service.removeCard(TENANT)).rejects.toMatchObject({
      status: 409,
      code: 'BILLING_MODEL_MISMATCH',
    });
    await expect(setup({ configured: false }).service.removeCard(TENANT)).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('handleCardEvent (#716)', () => {
  it('recognises the card lifecycle event types', () => {
    for (const type of [
      'setup_intent.succeeded',
      'setup_intent.setup_failed',
      'payment_method.detached',
      'payment_method.updated',
      'payment_method.automatically_updated',
      'customer.deleted',
    ]) {
      expect(isCardWebhookEvent(type)).toBe(true);
    }
    expect(isCardWebhookEvent('payment_method.attached')).toBe(false);
  });

  it('setup_intent.succeeded makes the saved card the default and detaches the old one', async () => {
    const { service, world, audit } = setup({
      cards: [card('pm_new'), card('pm_old')],
      defaultPm: 'pm_old',
    });
    await service.handleCardEvent(
      event('setup_intent.succeeded', { paymentMethodId: 'pm_new' }),
      TENANT,
    );
    expect(world.defaults.get(CUSTOMER)).toBe('pm_new');
    expect(world.detached).toEqual(['pm_old']);
    expect(auditTypes(audit)).toEqual([
      'setup_intent.succeeded',
      'payment_method.default_set',
      'payment_method.replaced',
    ]);
  });

  it('a redelivered setup_intent.succeeded for a replaced card changes nothing', async () => {
    const { service, stripe } = setup({ cards: [card('pm_newer')], defaultPm: 'pm_newer' });
    await service.handleCardEvent(
      event('setup_intent.succeeded', { paymentMethodId: 'pm_gone' }),
      TENANT,
    );
    expect(stripe.setDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(stripe.detachPaymentMethod).not.toHaveBeenCalled();
  });

  it('leaves flat-model cards alone (audit only)', async () => {
    const { service, stripe, audit } = setup({
      model: 'flat',
      cards: [card('pm_new'), card('pm_old')],
    });
    await service.handleCardEvent(
      event('setup_intent.succeeded', { paymentMethodId: 'pm_new' }),
      TENANT,
    );
    expect(stripe.detachPaymentMethod).not.toHaveBeenCalled();
    expect(auditTypes(audit)).toEqual(['setup_intent.succeeded']);
  });

  it('audits setup failures with the decline message', async () => {
    const { service, audit } = setup();
    await service.handleCardEvent(
      event('setup_intent.setup_failed', { failureMessage: 'authentication failed' }),
      TENANT,
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'setup_intent.setup_failed',
        payload: expect.objectContaining({ failureMessage: 'authentication failed' }),
      }),
    );
  });

  it('audits detach / update / automatic-update events', async () => {
    const { service, audit } = setup();
    for (const type of [
      'payment_method.detached',
      'payment_method.updated',
      'payment_method.automatically_updated',
    ]) {
      await service.handleCardEvent(event(type, { paymentMethodId: 'pm_1' }), TENANT);
    }
    expect(auditTypes(audit)).toEqual([
      'payment_method.detached',
      'payment_method.updated',
      'payment_method.automatically_updated',
    ]);
  });

  it('customer.deleted forgets the customer id so the next setup creates a new one', async () => {
    const { service, world, audit } = setup();
    await service.handleCardEvent(event('customer.deleted'), null);
    expect(world.customerByTenant.has(TENANT)).toBe(false);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantKey: TENANT,
        eventType: 'customer.deleted',
        payload: expect.objectContaining({ clearedTenant: true }),
      }),
    );
  });
});

describe('Stripe customer details (#716)', () => {
  it('a new customer carries the business name, builder email and builder id', async () => {
    const { service, world } = setup({ withCustomer: false });
    await service.ensureCustomer(TENANT, 'admin@elite.test');
    expect(world.customers.get(CUSTOMER)).toEqual({
      tenantKey: TENANT,
      email: 'billing@elite.test',
      name: 'Elite Craft Builders',
      builderId: 'b-1',
    });
  });

  it('an existing customer is re-synced on the next card setup', async () => {
    const { service, stripe } = setup();
    await expect(service.ensureCustomer(TENANT)).resolves.toBe(CUSTOMER);
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.updateCustomer).toHaveBeenCalledWith(CUSTOMER, {
      tenantKey: TENANT,
      name: 'Elite Craft Builders',
      builderId: 'b-1',
      email: 'billing@elite.test',
    });
  });

  it('a failed re-sync never blocks card setup', async () => {
    const { service, stripe, logWarning } = setup();
    (stripe.updateCustomer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('stripe down'),
    );
    await expect(service.ensureCustomer(TENANT)).resolves.toBe(CUSTOMER);
    expect(logWarning).toHaveBeenCalled();
  });

  it('syncCustomerDetails pushes a profile change and audits it', async () => {
    const { service, world, audit } = setup();
    await service.syncCustomerDetails({ ...BUILDER, businessName: 'Elite Craft Ltd' });
    expect(world.customers.get(CUSTOMER)).toMatchObject({ name: 'Elite Craft Ltd' });
    expect(auditTypes(audit)).toEqual(['customer.details_synced']);
  });

  it('syncCustomerDetails sends the billing address as the Stripe address (#881)', async () => {
    const { service, stripe } = setup();
    await service.syncCustomerDetails({
      ...BUILDER,
      billingAddress: {
        line1: '100 8 Ave SW',
        line2: 'Suite 400',
        city: 'Calgary',
        province: 'AB',
        postalCode: 'T2P 1J9',
        country: 'CA',
      },
    });
    expect(stripe.updateCustomer).toHaveBeenCalledWith(CUSTOMER, {
      tenantKey: TENANT,
      name: 'Elite Craft Builders',
      builderId: 'b-1',
      email: 'billing@elite.test',
      address: {
        line1: '100 8 Ave SW',
        line2: 'Suite 400',
        city: 'Calgary',
        state: 'AB',
        postalCode: 'T2P 1J9',
        country: 'CA',
      },
    });
  });

  it('syncCustomerDetails is a no-op without a customer, under flat, or when dormant', async () => {
    for (const opts of [
      { withCustomer: false },
      { model: 'flat' as const },
      { configured: false },
    ]) {
      const { service, stripe } = setup(opts);
      await service.syncCustomerDetails(BUILDER);
      expect(stripe.updateCustomer).not.toHaveBeenCalled();
    }
  });
});
