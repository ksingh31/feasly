/**
 * Attribution service tests (billing/01 foundation).
 *
 * Runs against PGlite with the real migration SQL (same files `db:migrate`
 * applies), so the table, FK, indexes, and defaults are exercised for real.
 *
 * Covers: introduction recording, contract reporting inside/outside the
 * attribution window, terminal-state transition guards, prior-relationship
 * exclusion, expiry, 404 on unknown id, and deadline accessors.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createAttributionService,
  type AttributionService,
} from '../src/services/billing/attribution.service';
import { estimates, leads } from '../src/db/schema';
import { ErrorCodes } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const BILLING = {
  model: 'commission' as const,
  commissionRate: 0.01,
  attributionWindowDays: 365,
  reportingSlaDays: 14,
  flatPlanName: 'Builder Standard',
  flatMonthlyCents: 30_000,
  flatCurrency: 'CAD',
};

const FIXED_NOW = new Date('2026-09-24T12:00:00.000Z');
const INTRODUCED_AT = new Date('2026-03-01T10:00:00.000Z');

let idCounter = 0;

function newService(testDb: TestDb): AttributionService {
  return createAttributionService({
    db: testDb.db,
    billing: BILLING,
    now: () => new Date(FIXED_NOW),
    // Deterministic valid UUIDs: 00000000-0000-4000-8000-<12-hex-counter>.
    newId: () => `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
  });
}

/** Minimal estimate+lead chain to satisfy the attribution_events FK. */
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

describe('attribution service', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('records an introduction with status introduced', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const record = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    expect(record).toMatchObject({
      leadId,
      tenantKey: 'elite-craft-builders',
      status: 'introduced',
      contractValueCents: null,
      contractSignedAt: null,
    });
    expect(record.introducedAt.toISOString()).toBe(INTRODUCED_AT.toISOString());
  });

  it('reports a contract signed inside the attribution window', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    const signedAt = new Date('2026-09-01T10:00:00.000Z'); // ~6 months later
    const record = await service.reportContract({
      attributionId: intro.id,
      contractValueCents: 85_000_000, // $850,000 excl. land
      contractSignedAt: signedAt,
    });
    expect(record.status).toBe('attributed');
    expect(record.contractValueCents).toBe(85_000_000);
    expect(record.contractSignedAt?.toISOString()).toBe(signedAt.toISOString());
  });

  it('rejects a contract signed outside the attribution window', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    const tooLate = new Date('2027-04-01T10:00:00.000Z'); // 13 months later
    await expect(
      service.reportContract({
        attributionId: intro.id,
        contractValueCents: 85_000_000,
        contractSignedAt: tooLate,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: ErrorCodes.VALIDATION_FAILED,
    });
  });

  it('rejects a non-positive contract value', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    await expect(
      service.reportContract({
        attributionId: intro.id,
        contractValueCents: 0,
        contractSignedAt: new Date('2026-09-01T10:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ status: 422, code: ErrorCodes.VALIDATION_FAILED });
  });

  it('marks an introduction expired', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    const record = await service.markExpired(intro.id);
    expect(record.status).toBe('expired');
  });

  it('excludes a prior relationship', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    const record = await service.excludePriorRelationship(intro.id);
    expect(record.status).toBe('excluded_prior_relationship');
  });

  it('guards terminal states against further transitions', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    await service.markExpired(intro.id);
    await expect(service.markExpired(intro.id)).rejects.toMatchObject({
      status: 409,
      code: ErrorCodes.CONFLICT,
    });
    await expect(
      service.reportContract({
        attributionId: intro.id,
        contractValueCents: 85_000_000,
        contractSignedAt: new Date('2026-09-01T10:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ status: 409, code: ErrorCodes.CONFLICT });
  });

  it('returns 404 for an unknown attribution id', async () => {
    const service = newService(testDb);
    await expect(
      service.getById('99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it('computes the reporting deadline from the contract signature', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    // No contract yet → no reporting deadline.
    expect(service.reportingDeadlineFor(intro)).toBeNull();

    const signedAt = new Date('2026-09-01T10:00:00.000Z');
    const attributed = await service.reportContract({
      attributionId: intro.id,
      contractValueCents: 85_000_000,
      contractSignedAt: signedAt,
    });
    // 14-day SLA from signature.
    expect(service.reportingDeadlineFor(attributed)?.toISOString()).toBe(
      '2026-09-15T10:00:00.000Z',
    );
  });

  it('computes the attribution deadline from the introduction', async () => {
    const service = newService(testDb);
    const leadId = await seedLead(testDb);
    const intro = await service.recordIntroduction({
      leadId,
      tenantKey: 'elite-craft-builders',
      introducedAt: INTRODUCED_AT,
    });
    // 365-day window from introduction.
    expect(service.attributionDeadlineFor(intro).toISOString()).toBe(
      '2027-03-01T10:00:00.000Z',
    );
  });
});
