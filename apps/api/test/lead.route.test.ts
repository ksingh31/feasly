/**
 * Lead route + pipeline tests (BE3-003).
 *
 * Covers: route delegation to the service interface, end-to-end capture
 * through the dedicated lead pipeline (PGlite-backed stores, real SQL),
 * RFC 7807 400s for invalid bodies, and the tight lead rate limiter
 * (429 with RATE_LIMITED once the window budget is spent).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createComposition, type AppComposition } from '../src/composition';
import { createLeadRoute } from '../src/routes/lead.route';
import { createLeadService } from '../src/services/lead.service';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleMagicLinkStore } from '../src/services/magic-link.store';
import { createDrizzlePrivacyStore } from '../src/services/privacy.store';
import { isProblemDetails } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/feasly_test',
  // Tight budget so the rate-limit test doesn't need hundreds of requests.
  LEAD_RATE_LIMIT_MAX_REQUESTS: '2',
} as NodeJS.ProcessEnv;

describe('lead route', () => {
  it('delegates to the service interface', async () => {
    const estimateStore = {
      save: async () => {},
      findById: async () => null,
      setNarrative: async () => false,
    };
    const leadStore = {
      findRecentByEmailAndAddress: async () => null,
    listLeads: async () => [],
      insert: async (lead: {
        id: string;
        estimateId: string;
        addressKey: string;
        email: string;
        name: string;
        timeline: string;
        marketingConsent: boolean;
        consentTs: Date;
        source: string;
      }) => ({
        ...lead,
        phone: null,
        tenantKey: null,
        quarantined: false,
        sandbox: false,
        leadScore: 0,
        status: 'new',
        unsubscribedAt: null,
        nudgeSentAt: null,
        sheetsSyncedAt: null,
        updatedAt: new Date(),
        createdAt: new Date(),
      }),
      findById: async () => null,
      setUnsubscribedAt: async () => null,
      findNudgeCandidates: async () => [],
      setNudgeSentAt: async () => null,
      findAllByEmail: async () => [],
      deleteByEmail: async () => 0,
      updateOnRepeat: async () => {
        throw new Error('not implemented');
      },
      findNewestEstimateIdByEmailAndAddress: async () => null,
      appendNote: async () => {},
      getNotes: async () => [],
      appendStatusHistory: async () => {},
      getStatusHistory: async () => [],
      findSheetsSyncCandidates: async () => [],
      setSheetsSyncedAt: async () => null,
    };
    const service = createLeadService({
      store: leadStore,
      estimateStore,
      magicLinks: {
        issue: async () => ({
          id: 'mlink-1',
          token: 'raw-token',
          expiresAt: new Date(),
        }),
        findByToken: async () => null,
        findByLeadIds: async () => [],
        revokeByLeadIds: async () => 0,
        markUsed: async () => true,
      },
      email: {
        sendMagicLink: async () => ({ provider: 'log' as const }),
        sendPartnerShare: async () => ({ provider: 'log' as const }),
        sendCallbackConfirmation: async () => ({ provider: 'log' as const }),
        sendNudge: async () => ({ provider: 'log' as const }),
        sendOpsAlert: async () => ({ provider: 'log' as const }),
      },
      appBaseUrl: 'https://feasly.example',
      dedupWindowDays: 90,
      magicLinkTtlSeconds: 900,
    });
    const route = createLeadRoute({ leads: service });
    // Unknown estimate → the service's 400, proving delegation.
    const error = await route
      .handle({
        email: 'sam@example.com',
        name: 'Sam',
        marketingConsent: false,
        estimateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
      .catch((e) => e);
    expect(error.status).toBe(400);
  });
});

describe('leads through the lead pipeline (PGlite-backed stores)', () => {
  let testDb: TestDb;
  let app: AppComposition;
  let estimateId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createComposition(TEST_ENV, {
      estimateStore: createDrizzleEstimateStore({ db: testDb.db }),
      leadStore: createDrizzleLeadStore({ db: testDb.db }),
      // Back every store by the same PGlite DB — the magic-link FK points
      // at leads, so the default (real-pool) store would see a different
      // database and every issuance would fail the FK check.
      magicLinkStore: createDrizzleMagicLinkStore({ db: testDb.db }),
      privacyStore: createDrizzlePrivacyStore({ db: testDb.db }),
    });
    // Seed one estimate for the lead to attach to (real store path).
    const estimate = await app.estimateRoute.handle({
      property: {
        addressKey: 'calgary-789-fake-blvd-nw',
        assessedLandValue: 400_000,
        lotSizeSqft: 4_500,
        zoning: 'R-C2',
      },
      scope: { buildSqft: 2_000, tier: 'standard' },
    });
    estimateId = estimate.estimateId;
  }, 60_000);
  afterAll(async () => {
    await app.db.close();
    await testDb.close();
  });

  const validBody = () => ({
    email: 'sam@example.com',
    name: 'Sam',
    marketingConsent: true,
    estimateId,
  });

  it('captures a lead end to end', async () => {
    const outcome = await app.leadPipeline.run(
      { headers: {}, clientIp: '10.0.0.1' },
      () => app.leadRoute.handle(validBody()),
    );
    if (isProblemDetails(outcome)) throw new Error(`unexpected problem: ${outcome.title}`);
    expect(outcome.leadId).toBeDefined();
    // consumer/02: capture emails the magic link (log provider in tests).
    expect(outcome.magicLinkSent).toBe(true);
    expect(outcome.expiresInDays).toBe(7); // 7-day magic-link TTL (Karan decision 2026-09-24)
  });

  it('dedups a repeat POST inside the window (same lead id)', async () => {
    const first = await app.leadPipeline.run(
      { headers: {}, clientIp: '10.0.0.2' },
      () => app.leadRoute.handle({ ...validBody(), email: 'repeat@example.com' }),
    );
    const second = await app.leadPipeline.run(
      { headers: {}, clientIp: '10.0.0.2' },
      () => app.leadRoute.handle({ ...validBody(), email: 'repeat@example.com' }),
    );
    if (isProblemDetails(first) || isProblemDetails(second)) {
      throw new Error('unexpected problem on dedup path');
    }
    expect(second.leadId).toBe(first.leadId);
  });

  it('dedups across a fresh estimate for the same address (no duplicate lead)', async () => {
    const email = 'fresh-estimate@example.com';
    const first = await app.leadPipeline.run(
      { headers: {}, clientIp: '10.0.0.4' },
      () => app.leadRoute.handle({ email, name: 'Sam', marketingConsent: false, estimateId }),
    );
    if (isProblemDetails(first)) throw new Error('unexpected problem on first capture');
    // Same property, brand-new estimate record.
    const fresh = await app.estimateRoute.handle({
      property: {
        addressKey: 'calgary-789-fake-blvd-nw',
        assessedLandValue: 410_000,
        lotSizeSqft: 4_600,
        zoning: 'R-C2',
      },
      scope: { buildSqft: 2_100, tier: 'standard' },
    });
    expect(fresh.estimateId).not.toBe(estimateId);
    const second = await app.leadPipeline.run(
      { headers: {}, clientIp: '10.0.0.4' },
      () =>
        app.leadRoute.handle({
          email,
          name: 'Sam',
          marketingConsent: false,
          estimateId: fresh.estimateId,
        }),
    );
    if (isProblemDetails(second)) throw new Error('unexpected problem on dedup path');
    expect(second.leadId).toBe(first.leadId);
  });

  it('returns RFC 7807 problem details (400) for an invalid body', async () => {
    const outcome = await app.leadPipeline.run(
      { headers: {}, clientIp: '10.0.0.3' },
      () => app.leadRoute.handle({ email: 'zz-not-an-email-zz', estimateId }),
    );
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(400);
      expect(outcome.code).toBe('VALIDATION_FAILED');
      expect(outcome.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      // PII must not leak into the problem body.
      expect(JSON.stringify(outcome)).not.toContain('zz-not-an-email-zz');
    }
  });

  it('rate-limits the gate: 429 after the tight budget is spent', async () => {
    const ip = '10.0.0.99';
    const post = () =>
      app.leadPipeline.run({ headers: {}, clientIp: ip }, () =>
        app.leadRoute.handle({ ...validBody(), email: `rl-${Math.random()}@example.com` }),
      );
    // Budget is 2 (TEST_ENV); the first two go through…
    const r1 = await post();
    const r2 = await post();
    expect(isProblemDetails(r1)).toBe(false);
    expect(isProblemDetails(r2)).toBe(false);
    // …the third is rejected.
    const r3 = await post();
    expect(isProblemDetails(r3)).toBe(true);
    if (isProblemDetails(r3)) {
      expect(r3.status).toBe(429);
      expect(r3.code).toBe('RATE_LIMITED');
      expect(r3.retryAfterMs).toBeGreaterThan(0);
    }
  });
});
