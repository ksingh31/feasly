/**
 * Billing-health schema-drift regression tests (bug: admin billing
 * dashboard 500 for authenticated admin, 2026-09-27).
 *
 * If a billing table the rollup reads is missing (Postgres 42P01), the
 * service must throw an actionable 503 (DEPENDENCY_UNAVAILABLE naming the
 * table) — never a bare 500 that the dashboard can only render as
 * "Something went wrong". Any other failure passes through untouched so
 * programming bugs stay loud.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createBillingHealthService } from '../src/services/billing/billing-health.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { BillingConfig } from '../src/config';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { AppDb } from '../src/db/client';
import { createTestDb, type TestDb } from './pglite-db';

function makeBilling(): BillingConfig {
  return {
    model: 'commission',
    commissionRate: 0.01,
    attributionWindowDays: 365,
    reportingSlaDays: 14,
    flatPlanName: 'Builder Standard',
    flatMonthlyCents: 30_000,
    flatCurrency: 'CAD',
    stripeSecretKey: undefined,
    stripeWebhookSecret: undefined,
    stripeFlatPriceId: undefined,
    isProduction: false,
  };
}

// Dev has no Stripe keys: the dashboard must degrade via the isConfigured
// flag, never by touching the SDK.
const unconfiguredStripe = {
  isConfigured: false,
  testMode: false,
} as unknown as StripeService;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);

afterAll(async () => {
  await testDb.close();
});

describe('billing-health missing-table handling', () => {
  it('maps a missing billing table (42P01) to 503 DEPENDENCY_UNAVAILABLE naming the table', async () => {
    // Simulate the schema drift: the repair has not covered this table yet.
    // CASCADE because billing_disputes holds an FK to commission_invoices.
    await testDb.rows('DROP TABLE commission_invoices CASCADE');
    const service = createBillingHealthService({
      db: testDb.db,
      billing: makeBilling(),
      stripe: unconfiguredStripe,
    });
    const error = await service.getHealth().then(
      () => {
        throw new Error('expected getHealth to throw');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError;
    expect(http.status).toBe(503);
    expect(http.code).toBe(ErrorCodes.DEPENDENCY_UNAVAILABLE);
    expect(http.retryable).toBe(true);
    expect(http.message).toContain('commission_invoices');
  });

  it('passes non-schema errors through untouched (programming bugs stay loud)', async () => {
    const boom = new Error('boom');
    const brokenDb = {
      select: () => {
        throw boom;
      },
    } as unknown as AppDb;
    const service = createBillingHealthService({
      db: brokenDb,
      billing: makeBilling(),
      stripe: unconfiguredStripe,
    });
    await expect(service.getHealth()).rejects.toBe(boom);
  });
});
