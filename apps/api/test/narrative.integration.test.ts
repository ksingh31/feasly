/**
 * consumer/06 — AI narrative worker integration tests (PGlite).
 *
 * End-to-end through the real Drizzle stores: migration columns exist,
 * narrative persists and reads back, the generation log counts correctly,
 * and the audit/ops-alert seams fire through the service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NARRATIVE_FOOTER } from '@feasly/cost-engine';
import { HttpError } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleMagicLinkStore } from '../src/services/magic-link.store';
import {
  createDrizzleNarrativeGenerationStore,
} from '../src/services/narrative.store';
import { createDrizzlePrivacyStore } from '../src/services/privacy.store';
import { createLogNarrativeProvider } from '../src/services/narrative.provider';
import {
  createNarrativeService,
  type NarrativeServiceDeps,
} from '../src/services/narrative.service';

const NOW = new Date('2026-09-25T07:30:00Z');
const EMAIL = 'narrative-e2e@example.com';
const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEAD_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';

const FIGURES = {
  build: { low: 400000, base: 450000, high: 500000 },
  total: { low: 1050000, base: 1100000, high: 1150000 },
  land: { value: 650000 },
};

describe('narrative worker (PGlite)', () => {
  let testDb: TestDb;
  let token: string;
  const alerts: string[] = [];

  beforeAll(async () => {
    testDb = await createTestDb();

    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const magicLinks = createDrizzleMagicLinkStore({ db: testDb.db });

    await estimates.save({
      id: ESTIMATE_ID,
      projectType: 'new_build',
      addressKey: 'calgary-123-fake-st-nw',
      inputs: { sqft: 2000, tier: 'standard', garage: 'double', basement: 'finished' },
      figures: FIGURES,
      rows: [
        {
          key: 'structure',
          label: 'Structure',
          range: { low: 200000, base: 225000, high: 250000 },
        },
      ],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt: NOW,
      narrative: null,
      narrativeGeneratedAt: null,
    });

    await leads.insert({
      id: LEAD_ID,
      estimateId: ESTIMATE_ID,
      addressKey: 'calgary-123-fake-st-nw',
      email: EMAIL,
      name: 'E2E',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: NOW,
      source: 'api',
    });

    const issued = await magicLinks.issue({
      leadId: LEAD_ID,
      purpose: 'report',
      ttlSeconds: 7 * 86_400,
      clock: () => NOW,
    });
    token = issued.token;
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  function service(overrides: Partial<NarrativeServiceDeps> = {}) {
    return createNarrativeService({
      estimates: createDrizzleEstimateStore({ db: testDb.db }),
      magicLinks: createDrizzleMagicLinkStore({ db: testDb.db }),
      leads: createDrizzleLeadStore({ db: testDb.db }),
      generations: createDrizzleNarrativeGenerationStore({ db: testDb.db }),
      provider: createLogNarrativeProvider(),
      opsAlerts: {
        notifyFailure: async (type: string) => {
          alerts.push(type);
        },
      },
      audit: createDrizzlePrivacyStore({ db: testDb.db }),
      maxGenerationsPerDay: 5,
      generationWindowMs: 86_400_000,
      clock: () => NOW,
      ...overrides,
    });
  }

  it('migration 0018: narrative columns and generation log exist', async () => {
    const cols = await testDb.rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'estimates' AND column_name LIKE 'narrative%'
       ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'narrative',
      'narrative_generated_at',
    ]);
    const tables = await testDb.rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'narrative_generations'`,
    );
    expect(tables).toHaveLength(1);
  });

  it('generates, persists, and reads back the cached narrative (AC1)', async () => {
    const first = await service().generateNarrative(token, ESTIMATE_ID);
    expect(first.narrative).toContain(NARRATIVE_FOOTER);
    expect(first.narrativeGeneratedAt).toBe(NOW.toISOString());

    // Persisted on the estimate row.
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const stored = await estimates.findById(ESTIMATE_ID);
    expect(stored?.narrative).toBe(first.narrative);
    expect(stored?.narrativeGeneratedAt).toEqual(NOW);

    // Second call is cached — generation log still has exactly one row.
    const second = await service().generateNarrative(token, ESTIMATE_ID);
    expect(second.narrative).toBe(first.narrative);
    const generations = createDrizzleNarrativeGenerationStore({
      db: testDb.db,
    });
    expect(
      await generations.countSince(
        ESTIMATE_ID,
        new Date(NOW.getTime() - 86_400_000),
      ),
    ).toBe(1);
  });

  it('fails closed with 502 and an ops alert when validation fails twice (AC2)', async () => {
    const badNarrative =
      'Your total is $9,999,999 and this one never validates. ' +
      'Dollar figures are calculated deterministically from our cost model — not generated by AI.';
    const localAlerts: string[] = [];
    const svc = service({
      provider: { generate: async () => badNarrative },
      opsAlerts: {
        notifyFailure: async (type: string) => {
          localAlerts.push(type);
        },
      },
    });
    // Clear the cache so generation actually runs.
    await testDb.rows(
      `UPDATE estimates SET narrative = NULL, narrative_generated_at = NULL
       WHERE id = '${ESTIMATE_ID}'`,
    );
    const error = await svc.generateNarrative(token, ESTIMATE_ID).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('NARRATIVE_FAILED');
    expect(localAlerts).toEqual(['narrative_worker_failed']);
    // Nothing persisted.
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const stored = await estimates.findById(ESTIMATE_ID);
    expect(stored?.narrative).toBeNull();
  });

  it('enforces the daily generation cost guard against real rows (AC5)', async () => {
    const generations = createDrizzleNarrativeGenerationStore({
      db: testDb.db,
    });
    // Reset the log, then spend exactly five generations inside the window.
    await testDb.rows('DELETE FROM narrative_generations');
    for (let i = 0; i < 5; i++) {
      await generations.record(
        ESTIMATE_ID,
        new Date(NOW.getTime() - i * 3600_000),
      );
    }
    // Clear the cached narrative so the guard is actually reached.
    await testDb.rows(
      `UPDATE estimates SET narrative = NULL, narrative_generated_at = NULL
       WHERE id = '${ESTIMATE_ID}'`,
    );
    const error = await service()
      .generateNarrative(token, ESTIMATE_ID)
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(429);
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('audit denial rows land in privacy_audit_log on cross-user access (AC4)', async () => {
    const otherEstimateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const otherLeadId = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const magicLinks = createDrizzleMagicLinkStore({ db: testDb.db });

    await estimates.save({
      id: otherEstimateId,
      projectType: 'new_build',
      addressKey: 'calgary-999-fake-ave-nw',
      inputs: {},
      figures: FIGURES,
      rows: [],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt: NOW,
      narrative: null,
      narrativeGeneratedAt: null,
    });
    await leads.insert({
      id: otherLeadId,
      estimateId: otherEstimateId,
      addressKey: 'calgary-999-fake-ave-nw',
      email: 'other@example.com',
      name: 'Other',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: NOW,
      source: 'api',
    });
    const otherIssued = await magicLinks.issue({
      leadId: otherLeadId,
      purpose: 'report',
      ttlSeconds: 7 * 86_400,
      clock: () => NOW,
    });

    const error = await service()
      .generateNarrative(otherIssued.token, ESTIMATE_ID)
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(403);

    const auditRows = await testDb.rows<{ action: string; lead_id: string }>(
      `SELECT action, lead_id FROM privacy_audit_log
       WHERE action = 'narrative.denied' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.lead_id).toBe(otherLeadId);
  });
});
