/**
 * Admin estimate-lookup service tests (admin/03).
 *
 * Covers the story's acceptance criteria at the service layer:
 * - full detail for a known id (inputs, outputs, version, linked lead)
 * - 404 ESTIMATE_NOT_FOUND for unknown ids
 * - outputs use the report's field names (deep parity with the consumer
 *   ReportSnapshot figures — same serializer shape, no drift)
 * - narrative is null when the estimate has none (never invented)
 * - snapshot timeline: same addressKey, newest first
 */
import { describe, expect, it } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { createAdminEstimatesService } from '../src/services/admin-estimates.service';
import type { EstimateRecord } from '../src/services/estimate.store';
import type { LeadRecord } from '../src/services/lead.store';

const FIGURES = {
  build: { low: 480000, base: 500000, high: 540000 },
  total: { low: 680000, base: 700000, high: 740000 },
  land: { value: 200000 },
};

function estimateFixture(overrides?: Partial<EstimateRecord>): EstimateRecord {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectType: 'new_build',
    addressKey: 'calgary-123-fake-st-nw',
    inputs: { address: '123 Fake St NW', city: 'Calgary' },
    figures: FIGURES,
    rows: [{ label: 'Foundation', amount: 50000 }],
    costDataVersion: 'v0.1.0-unclibrated',
    createdAt: new Date('2026-09-20T10:00:00Z'),
    narrative: null,
    narrativeGeneratedAt: null,
    assumptions: null,
    ...overrides,
  };
}

function leadFixture(estimateId: string): LeadRecord {
  return {
    id: 'lead-1',
    estimateId,
    name: 'Test Homeowner',
    email: 'homeowner@example.com',
    phone: null,
    addressKey: 'calgary-123-fake-st-nw',
    timeline: 'exploring',
    source: 'web',
    tenantKey: null,
    leadScore: 0,
    status: 'new',
    marketingConsent: false,
    quarantined: false,
    sandbox: false,
    consentTs: new Date('2026-09-20T10:00:00Z'),
    unsubscribedAt: null,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: new Date('2026-09-20T10:05:00Z'),
    createdAt: new Date('2026-09-20T10:05:00Z'),
  };
}

interface World {
  estimates: EstimateRecord[];
  leads: LeadRecord[];
}

function makeService(world: World) {
  return createAdminEstimatesService({
    estimateStore: {
      save: async () => {},
      findById: async (id: string) =>
        world.estimates.find((e) => e.id === id) ?? null,
      findByAddressKey: async (addressKey: string) =>
        world.estimates
          .filter((e) => e.addressKey === addressKey)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      setNarrative: async () => false,
    },
    leadStore: {
      findRecentByEmailAndAddress: async () => null,
      listLeads: async () => [],
      insert: async () => {
        throw new Error('not used');
      },
      findById: async () => null,
      findByEstimateId: async (estimateId: string) =>
        world.leads.find((l) => l.estimateId === estimateId) ?? null,
      setUnsubscribedAt: async (_args: { readonly id: string; readonly at: Date }) => null,
      findNudgeCandidates: async () => [],
      setNudgeSentAt: async () => null,
      findAllByEmail: async () => [],
      deleteByEmail: async () => 0,
      updateOnRepeat: async () => {
        throw new Error('not used');
      },
      findNewestEstimateIdByEmailAndAddress: async () => null,
      appendNote: async () => {},
      getNotes: async () => [],
      appendStatusHistory: async () => {},
      getStatusHistory: async () => [],
      findSheetsSyncCandidates: async () => [],
      setSheetsSyncedAt: async (_args: { readonly id: string; readonly at: Date }) => null,
      countNeverSynced: async () => 0,
      listByTenantKey: async () => [],
      updateStatus: async () => null,
    },
  });
}

describe('admin/03 estimate lookup service', () => {
  it('returns full detail for a known id (AC1)', async () => {
    const estimate = estimateFixture();
    const service = makeService({
      estimates: [estimate],
      leads: [leadFixture(estimate.id)],
    });

    const detail = await service.getEstimate(estimate.id);

    expect(detail.id).toBe(estimate.id);
    expect(detail.projectType).toBe('new_build');
    expect(detail.inputs).toEqual(estimate.inputs);
    expect(detail.costDataVersion).toBe('v0.1.0-unclibrated');
    expect(detail.createdAt).toBe('2026-09-20T10:00:00.000Z');
    expect(detail.linkedLeadId).toBe('lead-1');
    expect(detail.rows).toEqual(estimate.rows);
  });

  it('uses the report field names so outputs deep-equal the consumer ReportSnapshot figures (AC1)', async () => {
    const estimate = estimateFixture();
    const service = makeService({ estimates: [estimate], leads: [] });

    const detail = await service.getEstimate(estimate.id);

    expect(detail.outputs).toEqual({
      buildRange: FIGURES.build,
      totalRange: FIGURES.total,
      landValue: FIGURES.land,
    });
  });

  it('returns narrative null when the estimate has none — never invents one (AC5)', async () => {
    const estimate = estimateFixture();
    const service = makeService({ estimates: [estimate], leads: [] });

    const detail = await service.getEstimate(estimate.id);

    expect(detail.narrative).toBeNull();
  });

  it('returns linkedLeadId null when the gate has not completed', async () => {
    const estimate = estimateFixture();
    const service = makeService({ estimates: [estimate], leads: [] });

    const detail = await service.getEstimate(estimate.id);

    expect(detail.linkedLeadId).toBeNull();
  });

  it('throws 404 ESTIMATE_NOT_FOUND for an unknown id (AC2)', async () => {
    const service = makeService({ estimates: [], leads: [] });

    const error = await service
      .getEstimate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError;
    expect(http.status).toBe(404);
    expect(http.code).toBe(ErrorCodes.ESTIMATE_NOT_FOUND);
  });

  it('returns the snapshot timeline for the address, newest first (AC4)', async () => {
    const older = estimateFixture({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: new Date('2026-09-18T10:00:00Z'),
    });
    const newer = estimateFixture({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: new Date('2026-09-22T10:00:00Z'),
    });
    const otherAddress = estimateFixture({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      addressKey: 'calgary-999-other-ave-nw',
      createdAt: new Date('2026-09-23T10:00:00Z'),
    });
    const service = makeService({
      estimates: [older, newer, otherAddress],
      leads: [],
    });

    const detail = await service.getEstimate(newer.id);

    expect(detail.snapshots.map((s) => s.id)).toEqual([newer.id, older.id]);
    expect(detail.snapshots[0]?.createdAt).toBe('2026-09-22T10:00:00.000Z');
  });
});
