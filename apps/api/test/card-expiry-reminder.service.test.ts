/**
 * #880 — one-time card-expiry reminder service (unit, fakes at the
 * interfaces). The PGlite end-to-end path is in
 * invoice-reviewer-timer.adapter.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Builder } from '@feasly/contracts';
import type { BillingConfig } from '../src/config';
import { createCardExpiryReminderService } from '../src/services/billing/card-expiry-reminder.service';
import type {
  CardExpiryReminderStore,
  CardReminderClaim,
} from '../src/services/billing/card-expiry-reminder.store';
import type { CardSummary, StripeService } from '../src/services/billing/stripe.service';
import type { CardExpiryReminderEmailInput } from '../src/services/email/email.service';

const NOW = new Date('2026-11-16T12:00:00.000Z');

const BILLING = {
  model: 'commission',
  commissionRate: 0.01,
  attributionWindowDays: 365,
  reportingSlaDays: 14,
  flatPlanName: 'Builder Standard',
  flatMonthlyCents: 30_000,
  flatCurrency: 'CAD',
  stripeSecretKey: 'sk_test_fake',
  stripeWebhookSecret: 'whsec_fake',
  stripeFlatPriceId: undefined,
  isProduction: false,
  cardExpiryWarningDays: 30,
} as BillingConfig;

/** Expires 2026-12-01 → 15 days away: inside the 30-day window. */
const SOON: CardSummary = { id: 'pm_soon', brand: 'visa', last4: '4242', expMonth: 11, expYear: 2026 };
/** Expires 2028 → outside the window. */
const LATER: CardSummary = { id: 'pm_later', brand: 'visa', last4: '1111', expMonth: 6, expYear: 2028 };
/** Expired 2026-11-01. */
const EXPIRED: CardSummary = { id: 'pm_expired', brand: 'visa', last4: '0002', expMonth: 10, expYear: 2026 };

function builder(overrides: Partial<Builder> = {}): Builder {
  return {
    id: 'b-1',
    tenantKey: 'elite',
    businessName: 'Elite Craft Builders',
    displayName: 'Elite Craft',
    email: 'office@elite.example',
    phone: null,
    logoUrl: null,
    accentColor: null,
    allowedOrigins: [],
    plan: 'commission',
    status: 'active',
    settings: {},
    commissionRatePercent: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Builder;
}

function memStore(): CardExpiryReminderStore & { claims: Map<string, CardReminderClaim> } {
  const claims = new Map<string, CardReminderClaim>();
  return {
    claims,
    listCustomers: async () => [{ tenantKey: 'elite', customerId: 'cus_elite' }],
    claim: async (input) => {
      if (claims.has(input.paymentMethodId)) return false;
      claims.set(input.paymentMethodId, input);
      return true;
    },
    release: async (id) => {
      claims.delete(id);
    },
  };
}

function setup(opts: {
  cards?: CardSummary[];
  defaultId?: string | null;
  builder?: Builder | null;
  admins?: string[];
  billing?: BillingConfig;
  sendFails?: boolean;
} = {}) {
  let cards = opts.cards ?? [SOON];
  const sends: CardExpiryReminderEmailInput[] = [];
  const store = memStore();
  const audit = { append: vi.fn(async () => ({}) as never) };
  const stripe = {
    isConfigured: true,
    listPaymentMethods: async () => cards,
    getDefaultPaymentMethodId: async () => opts.defaultId ?? null,
  } as unknown as StripeService;
  const service = createCardExpiryReminderService({
    billing: opts.billing ?? BILLING,
    stripe,
    store,
    email: {
      sendCardExpiryReminder: async (input) => {
        if (opts.sendFails) throw new Error('provider down');
        sends.push(input);
        return { sent: true, provider: 'log' };
      },
    },
    builders: {
      getByTenantKey: async () => (opts.builder === undefined ? builder() : opts.builder),
    },
    memberships: {
      listActiveOrgAdminEmails: async () => opts.admins ?? ['Admin@Elite.example', 'ops@elite.example'],
    },
    audit,
  });
  return {
    service,
    sends,
    store,
    audit,
    setCards: (next: CardSummary[]) => {
      cards = next;
    },
  };
}

describe('card-expiry reminder service (#880)', () => {
  it('emails every active org admin once when the card enters the window', async () => {
    const { service, sends, audit } = setup();
    const result = await service.runReminderCycle(NOW);
    expect(result).toMatchObject({ checked: 1, reminded: 1, emailsSent: 2, alreadyReminded: 0, skipped: 0 });
    expect(result.errors).toEqual([]);
    expect(sends.map((s) => s.to)).toEqual(['admin@elite.example', 'ops@elite.example']);
    expect(sends[0]).toMatchObject({ businessName: 'Elite Craft Builders', brand: 'visa', last4: '4242', expMonth: 11, expYear: 2026 });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'card.expiry_reminder_sent', entityId: 'pm_soon', tenantKey: 'elite' }),
    );
  });

  it('a second run sends nothing for the same card', async () => {
    const { service, sends } = setup();
    await service.runReminderCycle(NOW);
    const second = await service.runReminderCycle(NOW);
    expect(second).toMatchObject({ reminded: 0, emailsSent: 0, alreadyReminded: 1 });
    expect(sends).toHaveLength(2);
  });

  it('a replaced card gets its own reminder later', async () => {
    const { service, sends, setCards } = setup();
    await service.runReminderCycle(NOW);
    setCards([{ ...SOON, id: 'pm_replacement', last4: '5555' }]);
    const result = await service.runReminderCycle(NOW);
    expect(result.reminded).toBe(1);
    expect(sends.map((s) => s.last4)).toEqual(['4242', '4242', '5555', '5555']);
  });

  it('reminds about the default card, not a newer non-default one', async () => {
    const { service, sends } = setup({ cards: [LATER, SOON], defaultId: 'pm_soon' });
    await service.runReminderCycle(NOW);
    expect(sends[0]?.last4).toBe('4242');
  });

  it.each([
    ['outside the window', { cards: [LATER] }],
    ['already expired', { cards: [EXPIRED] }],
    ['no card', { cards: [] }],
    ['no builder row', { builder: null }],
    ['flat plan', { builder: builder({ plan: 'flat' }) }],
    ['suspended builder', { builder: builder({ status: 'suspended' }) }],
    ['offboarded builder', { builder: builder({ status: 'offboarded' }) }],
    ['no recipient', { admins: [], builder: builder({ email: null }) }],
  ])('skips without claiming: %s', async (_label, opts) => {
    const { service, sends, store } = setup(opts as Parameters<typeof setup>[0]);
    const result = await service.runReminderCycle(NOW);
    expect(result).toMatchObject({ checked: 1, reminded: 0, skipped: 1 });
    expect(sends).toEqual([]);
    expect(store.claims.size).toBe(0);
  });

  it('falls back to the builder contact email when the org has no active admin', async () => {
    const { service, sends } = setup({ admins: [] });
    await service.runReminderCycle(NOW);
    expect(sends.map((s) => s.to)).toEqual(['office@elite.example']);
  });

  it('sends nothing when the billing model is not commission', async () => {
    const { service, sends } = setup({ billing: { ...BILLING, model: 'flat' } as BillingConfig });
    const result = await service.runReminderCycle(NOW);
    expect(result.checked).toBe(0);
    expect(sends).toEqual([]);
  });

  it('releases the claim and reports the failure when every send fails, so the next run retries', async () => {
    const { service, store } = setup({ sendFails: true });
    const result = await service.runReminderCycle(NOW);
    expect(result.reminded).toBe(0);
    expect(result.errors).toEqual([{ message: 'provider down' }]);
    expect(store.claims.size).toBe(0);
  });
});
