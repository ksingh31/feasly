/**
 * #710 — builders created in the admin console get a `tenants` row.
 *
 * Sign-in sessions, the portal allowlist, commission invoices, disputes and
 * the Stripe customer id all hang off `tenants.tenant_key` by foreign key.
 * Before #710, `BuilderService.createBuilder` wrote only `builders`, so a
 * newly created builder could not sign in (builder_sessions FK — the
 * 2026-09-29 incident), save a card (saveCustomerId silently matched zero
 * rows) or be invoiced (commission_invoices FK).
 *
 * Runs against PGlite with every migration applied plus REPAIR_SQL. Stripe
 * is a fake client behind the REAL StripeService (so the tenants persistence
 * path is exercised); no network.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createBuilderService } from '../src/services/builder.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import {
  createStripeService,
  type StripeClient,
} from '../src/services/billing/stripe.service';
import { createCommissionCardService } from '../src/services/billing/commission-card.service';
import { createBillingAuditService } from '../src/services/billing/billing-audit.service';
import { createAttributionService } from '../src/services/billing/attribution.service';
import { createCommissionService } from '../src/services/billing/commission.service';
import type { EmailService } from '../src/services/email/email.service';
import type { BillingConfig } from '../src/config';
import { estimates, leads } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';

const BILLING: BillingConfig = {
  model: 'commission',
  commissionRate: 0.01,
  attributionWindowDays: 365,
  reportingSlaDays: 14,
  flatPlanName: 'Builder Standard',
  flatMonthlyCents: 30_000,
  flatCurrency: 'CAD',
  stripeSecretKey: 'sk_test_fake',
  stripeWebhookSecret: 'whsec_fake',
} as BillingConfig;

const FIXED_NOW = new Date('2026-09-24T12:00:00.000Z');

function fakeStripeClient(): StripeClient & { customersCreated: string[] } {
  const customersCreated: string[] = [];
  const client = {
    customersCreated,
    createCustomer: vi.fn(async (input: { tenantKey: string }) => {
      const id = `cus_${input.tenantKey}_${customersCreated.length + 1}`;
      customersCreated.push(id);
      return { id };
    }),
    createSetupIntent: vi.fn(async (customerId: string) => ({
      id: `seti_${customerId}`,
      clientSecret: `secret_${customerId}`,
    })),
    listPaymentMethods: vi.fn(async () => []),
    createOffSessionPaymentIntent: vi.fn(),
    refundPaymentIntent: vi.fn(),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    constructWebhookEvent: vi.fn(),
  };
  return client as unknown as StripeClient & { customersCreated: string[] };
}

/** Email fake: every method records and reports "sent", never sends. */
function fakeEmail(): EmailService {
  return new Proxy(
    {},
    {
      get: () => async () => ({ sent: true, provider: 'log' as const }),
    },
  ) as EmailService;
}

const audit = { log: vi.fn(async () => {}) } as unknown as AdminAuditStore;

async function seedLead(testDb: TestDb): Promise<string> {
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: '710-test-st-calgary',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  const leadId = randomUUID();
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: '710-test-st-calgary',
    email: 'homeowner@example.com',
    name: 'Test Homeowner',
    timeline: '6-12 months',
    consentTs: new Date('2026-03-01T09:00:00.000Z'),
  });
  return leadId;
}

describe('admin-created builder is fully provisioned (#710)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await testDb.exec(REPAIR_SQL as string);
    // PGlite WASM init + migrations can exceed vitest's 10s default.
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('create → invite → sign-in session insert needs no manual SQL (AC1)', async () => {
    const builders = createBuilderService({ db: testDb.db, audit });
    const builder = await builders.createBuilder(
      {
        tenantKey: 'second-builder',
        businessName: 'Second Builder Ltd.',
        displayName: 'Second Builder',
        allowedOrigins: ['https://second.example.com'],
      },
      'admin@example.com',
    );

    const tenantRows = await testDb.rows<{
      tenant_key: string;
      display_name: string;
      allowed_origins: string[];
      accent_color: string;
    }>(`SELECT * FROM tenants WHERE tenant_key = 'second-builder'`);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]).toMatchObject({
      display_name: 'Second Builder',
      allowed_origins: ['https://second.example.com'],
      accent_color: '',
    });

    // Invite: portal allowlist (FK → tenants).
    await testDb.rows(
      `INSERT INTO builder_allowlist (email, tenant_key, added_by)
       VALUES ('owner@second.example.com', 'second-builder', 'admin@example.com')`,
    );
    // Sign-in: the exact session insert shape the builder callback performs
    // (FK → tenants) — this raised builder_sessions_tenant_key_fkey before.
    await testDb.rows(
      `INSERT INTO builder_sessions
         (id, email, tenant_key, session_token_hash, builder_id, expires_at)
       VALUES
         (gen_random_uuid(), 'owner@second.example.com', 'second-builder',
          'test-hash-' || gen_random_uuid()::text, '${builder.id}',
          now() + interval '7 days')`,
    );
    const sessions = await testDb.rows(
      `SELECT 1 FROM builder_sessions WHERE tenant_key = 'second-builder'`,
    );
    expect(sessions).toHaveLength(1);
  });

  it('update keeps the shared tenants fields in sync', async () => {
    const builders = createBuilderService({ db: testDb.db, audit });
    const builder = await builders.getByTenantKey('second-builder');
    await builders.updateBuilder(
      builder!.id,
      { displayName: 'Second Builder Renamed', accentColor: '#112233' },
      'admin@example.com',
    );
    const rows = await testDb.rows<{ display_name: string; accent_color: string }>(
      `SELECT display_name, accent_color FROM tenants WHERE tenant_key = 'second-builder'`,
    );
    expect(rows[0]).toEqual({
      display_name: 'Second Builder Renamed',
      accent_color: '#112233',
    });
  });

  it('card setup creates one Stripe customer, persists it, and reuses it (AC2)', async () => {
    const client = fakeStripeClient();
    const stripe = createStripeService({ db: testDb.db, billing: BILLING, client });
    const card = createCommissionCardService({
      billing: BILLING,
      audit: createBillingAuditService({ db: testDb.db }),
      stripe,
    });

    const first = await card.ensureCustomer('second-builder');
    const intent = await card.createSetupIntent('second-builder');
    const second = await card.ensureCustomer('second-builder');

    expect(client.customersCreated).toEqual([first]);
    expect(second).toBe(first);
    expect(intent.setupIntentId).toBe(`seti_${first}`);
    expect(await stripe.getCustomerId('second-builder')).toBe(first);

    // A builder update must never wipe the persisted Stripe customer id.
    const builders = createBuilderService({ db: testDb.db, audit });
    const builder = await builders.getByTenantKey('second-builder');
    await builders.updateBuilder(builder!.id, { phone: '403-555-0100' }, 'admin@example.com');
    expect(await stripe.getCustomerId('second-builder')).toBe(first);
  });

  it('an invoice can be created for that builder (AC3)', async () => {
    const stripe = createStripeService({
      db: testDb.db,
      billing: BILLING,
      client: fakeStripeClient(),
    });
    const attribution = createAttributionService({
      db: testDb.db,
      billing: BILLING,
      now: () => new Date(FIXED_NOW),
    });
    const commission = createCommissionService({
      db: testDb.db,
      billing: BILLING,
      attribution,
      audit: createBillingAuditService({ db: testDb.db }),
      stripe,
      email: fakeEmail(),
      opsInbox: 'ops@example.com',
      now: () => new Date(FIXED_NOW),
    });
    const leadId = await seedLead(testDb);
    const intro = await attribution.recordIntroduction({
      leadId,
      tenantKey: 'second-builder',
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const reported = await attribution.reportContract({
      attributionId: intro.id,
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
      reportedAt: new Date('2026-06-05T10:00:00.000Z'),
    });

    const invoice = await commission.createDraftInvoice(reported.id);
    expect(invoice).toMatchObject({
      tenantKey: 'second-builder',
      commissionCents: 500_000,
    });
  });

  it('saveCustomerId fails loudly when no tenants row exists (AC4)', async () => {
    const stripe = createStripeService({
      db: testDb.db,
      billing: BILLING,
      client: fakeStripeClient(),
    });
    await expect(
      stripe.saveCustomerId('no-such-builder', 'cus_orphan'),
    ).rejects.toThrow(/no tenants row/);
  });

  it('repair SQL backfills a tenants row for a pre-#710 builder, idempotently (AC5)', async () => {
    // A builder created before the fix: builders row, no tenants row.
    await testDb.rows(
      `INSERT INTO builders
         (id, tenant_key, business_name, display_name, email, phone,
          logo_url, accent_color, allowed_origins, plan, status)
       VALUES
         ('${randomUUID()}', 'legacy-builder', 'Legacy Ltd.', 'Legacy',
          NULL, NULL, NULL, NULL,
          '["https://legacy.example.com"]'::jsonb, NULL, 'active')`,
    );
    const legacy = () =>
      testDb.rows<{
        tenant_key: string;
        allowed_origins: string[];
        logo_url: string;
        fallback_email: string;
      }>(`SELECT * FROM tenants WHERE tenant_key = 'legacy-builder'`);
    expect(await legacy()).toHaveLength(0);

    await testDb.exec(REPAIR_SQL as string);
    const rows = await legacy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allowed_origins: ['https://legacy.example.com'],
      logo_url: '',
      fallback_email: '',
    });

    // Idempotent, and never touches an existing row's Stripe customer id.
    const before = await testDb.rows<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE tenant_key = 'second-builder'`,
    );
    await testDb.exec(REPAIR_SQL as string);
    expect(await legacy()).toHaveLength(1);
    const after = await testDb.rows<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE tenant_key = 'second-builder'`,
    );
    expect(after).toEqual(before);
    expect(after[0]!.stripe_customer_id).not.toBeNull();
  });
});
