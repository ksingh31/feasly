/**
 * Embed billing hook tests (billing/01 first charge path).
 *
 * Runs against PGlite with the real migration SQL. The Stripe client and
 * email service are fakes — no network, no real charges. Covers:
 * - lead_created stays audit-only (never billed),
 * - commission won + contract details → attribution → draft invoice →
 *   auto-submitted into review (billed:true, invoiceStatus in_review),
 * - won without contract details → parked (awaiting_contract_details),
 * - won retry is idempotent (one attribution → one invoice, no duplicate),
 * - flat model → won is covered by the subscription (no invoice),
 * - disputed invoice freezes the charge path (existing_disputed),
 * - 14-day reporting breach flags the invoice + appends sla.breached,
 * - every state change appends a billing_events row,
 * - the hook never touches Stripe (grep test).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmbedBillingHookService,
  type EmbedBillingHookService,
} from '../src/services/billing/embed-billing-hook.service';
import {
  createBillingAuditService,
  type BillingAuditService,
} from '../src/services/billing/billing-audit.service';
import {
  createAttributionService,
  type AttributionService,
} from '../src/services/billing/attribution.service';
import {
  createCommissionService,
  type CommissionService,
} from '../src/services/billing/commission.service';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import {
  estimates,
  leads,
  tenants,
  billingEvents,
  commissionInvoices,
} from '../src/db/schema';
import { eq } from 'drizzle-orm';
import type { BillingConfig } from '../src/config';
import { createTestDb, type TestDb } from './pglite-db';

const COMMISSION_BILLING = {
  model: 'commission' as const,
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
};

const FLAT_BILLING = { ...COMMISSION_BILLING, model: 'flat' as const };

const FIXED_NOW = new Date('2026-09-24T12:00:00.000Z');

let idCounter = 9000;
function nextId(): string {
  return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
}

/** Fake Stripe: records calls, never touches the network. */
function fakeStripe(): StripeService & { calls: unknown[] } {
  const calls: unknown[] = [];
  const service: StripeService = {
    isConfigured: true,
    testMode: true,
    createCustomer: async (input) => {
      calls.push({ op: 'createCustomer', input });
      return { id: 'cus_test_123' };
    },
    createSetupIntent: async (customerId) => {
      calls.push({ op: 'createSetupIntent', customerId });
      return { id: 'seti_test_123', clientSecret: 'seti_test_secret' };
    },
    createOffSessionPaymentIntent: async (input, idempotencyKey) => {
      calls.push({ op: 'createOffSessionPaymentIntent', input, idempotencyKey });
      return { id: 'pi_test_1', status: 'requires_capture' };
    },
    createSubscription: async (input) => {
      calls.push({ op: 'createSubscription', input });
      return { id: 'sub_test_123', status: 'active' };
    },
    cancelSubscription: async (subscriptionId) => {
      calls.push({ op: 'cancelSubscription', subscriptionId });
      return { id: subscriptionId };
    },
    verifyWebhook: () => {
      throw new Error('not used in these tests');
    },
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
    getCustomerId: async (tenantKey: string) => {
      calls.push({ op: 'getCustomerId', tenantKey });
      return 'cus_test_123';
    },
  };
  return Object.assign(service, { calls });
}

/** Fake email: records sends, never sends. */
function fakeEmail(): EmailService & { sent: unknown[] } {
  const sent: unknown[] = [];
  const service = {
    sendMagicLink: async (input: unknown) => {
      sent.push({ op: 'sendMagicLink', input });
      return { sent: true };
    },
    sendPartnerShare: async (input: unknown) => {
      sent.push({ op: 'sendPartnerShare', input });
      return { sent: true };
    },
    sendCallbackConfirmation: async (input: unknown) => {
      sent.push({ op: 'sendCallbackConfirmation', input });
      return { sent: true };
    },
    sendNudge: async (input: unknown) => {
      sent.push({ op: 'sendNudge', input });
      return { sent: true };
    },
    sendOpsAlert: async (input: unknown) => {
      sent.push({ op: 'sendOpsAlert', input });
      return { sent: true };
    },
  };
  return Object.assign(service as unknown as EmailService, { sent });
}

interface Fixtures {
  hook: EmbedBillingHookService;
  attribution: AttributionService;
  commission: CommissionService;
  audit: BillingAuditService;
  stripe: StripeService & { calls: unknown[] };
  email: EmailService & { sent: unknown[] };
}

function newFixtures(testDb: TestDb, billing: BillingConfig): Fixtures {
  const stripe = fakeStripe();
  const email = fakeEmail();
  const audit = createBillingAuditService({ db: testDb.db, newId: nextId });
  const attribution = createAttributionService({
    db: testDb.db,
    billing,
    now: () => new Date(FIXED_NOW),
    newId: nextId,
  });
  const commission = createCommissionService({
    db: testDb.db,
    billing,
    attribution,
    audit,
    stripe,
    email,
    opsInbox: 'ops@example.com',
    now: () => new Date(FIXED_NOW),
    newId: nextId,
  });
  const hook = createEmbedBillingHookService({
    billing,
    attribution,
    commission,
    audit,
    now: () => new Date(FIXED_NOW),
  });
  return { hook, attribution, commission, audit, stripe, email };
}

async function seedTenant(testDb: TestDb, key: string): Promise<void> {
  await testDb.db.insert(tenants).values({
    tenantKey: key,
    businessName: `${key} Inc`,
    displayName: key,
    accentColor: '#B08D57',
    allowedOrigins: ['https://example.com'],
    stripeCustomerId: 'cus_test_123',
  });
}

async function seedLead(testDb: TestDb): Promise<string> {
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: '123-test-st-calgary',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  const leadId = randomUUID();
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: '123-test-st-calgary',
    email: 'homeowner@example.com',
    name: 'Test Homeowner',
    timeline: '6-12 months',
    consentTs: new Date('2026-03-01T09:00:00.000Z'),
  });
  return leadId;
}

describe('embed billing hook — first charge path', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('lead_created stays audit-only and never bills', async () => {
    const tenantKey = 'hook-lead-created';
    await seedTenant(testDb, tenantKey);
    const { hook } = newFixtures(testDb, COMMISSION_BILLING);

    const result = await hook.recordBillableEvent(tenantKey, 'lead_created');

    expect(result).toEqual({
      billed: false,
      reason: 'billing_not_enabled',
    });
    const invoices = await testDb.db
      .select()
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    expect(invoices).toHaveLength(0);
    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.tenantKey, tenantKey));
    expect(events.some((e) => e.eventType === 'embed.lead_created')).toBe(true);
  });

  it('commission won + contract → draft invoice auto-submitted into review', async () => {
    const tenantKey = 'hook-won-charge';
    await seedTenant(testDb, tenantKey);
    const { hook } = newFixtures(testDb, COMMISSION_BILLING);
    const leadId = await seedLead(testDb);

    const result = await hook.recordBillableEvent(tenantKey, 'lead_won', {
      leadId,
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
      contractValueCents: 50_000_000, // $500,000 excl. land
      contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
    });

    expect(result.billed).toBe(true);
    if (!result.billed) throw new Error('expected a billed result');
    expect(result.invoiceStatus).toBe('in_review');
    expect(result.invoiceId).toBeTruthy();

    const invoices = await testDb.db
      .select()
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    expect(invoices).toHaveLength(1);
    expect(invoices[0].tenantKey).toBe(tenantKey);
    expect(invoices[0].commissionCents).toBe(500_000); // 1% of $500k
    expect(invoices[0].status).toBe('in_review');
    expect(invoices[0].slaBreached).toBe(false);

    // Every state change appends billing_events.
    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.tenantKey, tenantKey));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('billing.won_invoiced');
    expect(types).toContain('invoice.created');
    // submitForReview appends invoice.status_changed (draft → in_review).
    expect(types).toContain('invoice.status_changed');
  });

  it('won without contract details parks the invoice (awaiting_contract_details)', async () => {
    const tenantKey = 'hook-won-parked';
    await seedTenant(testDb, tenantKey);
    const { hook } = newFixtures(testDb, COMMISSION_BILLING);
    const leadId = await seedLead(testDb);

    const result = await hook.recordBillableEvent(tenantKey, 'lead_won', {
      leadId,
    });

    expect(result).toEqual({
      billed: false,
      reason: 'awaiting_contract_details',
    });
    const invoices = await testDb.db
      .select()
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    expect(invoices).toHaveLength(0);
  });

  it('won retry is idempotent: one attribution yields exactly one invoice', async () => {
    const tenantKey = 'hook-won-idempotent';
    await seedTenant(testDb, tenantKey);
    const { hook } = newFixtures(testDb, COMMISSION_BILLING);
    const leadId = await seedLead(testDb);
    const detail = {
      leadId,
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
    };

    const first = await hook.recordBillableEvent(tenantKey, 'lead_won', detail);
    const second = await hook.recordBillableEvent(tenantKey, 'lead_won', detail);

    expect(first.billed).toBe(true);
    if (!first.billed) throw new Error('expected a billed result');
    expect(second).toMatchObject({
      billed: true,
      reason: 'existing_invoice',
      invoiceId: first.invoiceId,
      invoiceStatus: 'in_review',
    });
    const invoices = await testDb.db
      .select()
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    expect(invoices).toHaveLength(1);
  });

  it('flat model: won is covered by the subscription, no invoice', async () => {
    const tenantKey = 'hook-won-flat';
    await seedTenant(testDb, tenantKey);
    const { hook } = newFixtures(testDb, FLAT_BILLING);
    const leadId = await seedLead(testDb);

    const result = await hook.recordBillableEvent(tenantKey, 'lead_won', {
      leadId,
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
    });

    expect(result).toEqual({
      billed: false,
      reason: 'flat_subscription_covers',
    });
    const invoices = await testDb.db
      .select()
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    expect(invoices).toHaveLength(0);
  });

  it('disputed invoice freezes the charge path', async () => {
    const tenantKey = 'hook-won-disputed';
    await seedTenant(testDb, tenantKey);
    const { hook, commission } = newFixtures(testDb, COMMISSION_BILLING);
    const leadId = await seedLead(testDb);
    const detail = {
      leadId,
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
    };

    const first = await hook.recordBillableEvent(tenantKey, 'lead_won', detail);
    if (!first.billed) throw new Error('expected a billed result');
    await commission.disputeInvoice(first.invoiceId, 'builder disagrees');

    const retry = await hook.recordBillableEvent(tenantKey, 'lead_won', detail);

    expect(retry).toMatchObject({
      billed: true,
      reason: 'existing_disputed',
      invoiceId: first.invoiceId,
      invoiceStatus: 'disputed',
    });
    const invoices = await testDb.db
      .select()
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('disputed');
  });

  it('14-day reporting breach flags the invoice and appends sla.breached', async () => {
    const tenantKey = 'hook-won-sla';
    await seedTenant(testDb, tenantKey);
    const { hook } = newFixtures(testDb, COMMISSION_BILLING);
    const leadId = await seedLead(testDb);

    // Signed 2026-06-01, reported 2026-09-24 (FIXED_NOW): 20 days past the
    // 14-day SLA, still inside the 365-day attribution window.
    const result = await hook.recordBillableEvent(tenantKey, 'lead_won', {
      leadId,
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
    });

    expect(result.billed).toBe(true);
    if (!result.billed) throw new Error('expected a billed result');
    expect(result.invoiceStatus).toBe('in_review');
    const invoices = await testDb.db
      .select()
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    expect(invoices).toHaveLength(1);
    expect(invoices[0].slaBreached).toBe(true);
    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.tenantKey, tenantKey));
    expect(events.some((e) => e.eventType === 'sla.breached')).toBe(true);
  });
});

describe('no Stripe in the embed hook', () => {
  const HOOK_FILE = join(
    __dirname,
    '..',
    'src',
    'services',
    'billing',
    'embed-billing-hook.service.ts',
  );

  /** Strip comments so doc mentions ("never touches Stripe") don't trip the grep. */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it('the hook source has no stripe import or usage', () => {
    const src = codeOnly(readFileSync(HOOK_FILE, 'utf8'));
    expect(src.toLowerCase()).not.toContain('stripe');
  });

  it('the hook imports only billing services (no stripe.service)', () => {
    const src = readFileSync(HOOK_FILE, 'utf8');
    const imports = src
      .split('\n')
      .filter((l) => l.startsWith('import '))
      .join('\n');
    expect(imports).toContain('billing-audit.service');
    expect(imports).toContain('attribution.service');
    expect(imports).toContain('commission.service');
    expect(imports).not.toContain('stripe.service');
    expect(imports).not.toContain('flat-plan.service');
  });
});
