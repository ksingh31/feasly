/**
 * Phase-2 wiring — report snapshot endpoints tests.
 *
 * Service (deps faked at the interface boundary), route (service stubbed),
 * and contract-conformance: every response parses through the contracts
 * `ReportSnapshot` zod schema. Semantics covered:
 * - GET /v1/reports/{token}: v1 materialized from the estimate row; later
 *   calls return the latest snapshot; unknown/expired tokens → 404.
 * - POST /v1/reports/{token}/revisions: tier/sqft what-if appends a new
 *   immutable version; empty body → 400.
 */
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { ErrorCodes } from '../src/middleware/errors';
import { ReportSnapshotSchema } from '../src/openapi/schemas';
import { createReportRoute } from '../src/routes/report.route';
import {
  createReportService,
  type ReportService,
} from '../src/services/report.service';
import type { EstimateRecord, EstimateStore } from '../src/services/estimate.store';
import type { LeadRecord, LeadStore } from '../src/services/lead.store';
import type { MagicLinkRecord, MagicLinkStore } from '../src/services/magic-link.store';
import type { PropertyService } from '../src/services/property.service';
import type {
  NewReportSnapshot,
  ReportSnapshotRecord,
  ReportSnapshotStore,
} from '../src/services/report-snapshot.store';

const LEAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ESTIMATE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ADDRESS_KEY = 'calgary:123-elm-st';
const TOKEN = 'raw-report-token';

const RANGE = { low: 400000, base: 450000, high: 500000 };

const LEAD: LeadRecord = {
  id: LEAD_ID,
  estimateId: ESTIMATE_ID,
  addressKey: ADDRESS_KEY,
  email: 'homeowner@example.com',
  name: 'Home Owner',
  phone: null,
  timeline: 'exploring',
  marketingConsent: false,
  consentTs: new Date('2026-09-26T04:00:00Z'),
  tenantKey: null,
  source: 'web',
  quarantined: false,
  sandbox: false,
  leadScore: 50,
  status: 'new',
  unsubscribedAt: null,
  nudgeSentAt: null,
} as LeadRecord;

function liveLink(): MagicLinkRecord {
  return {
    id: 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm',
    leadId: LEAD_ID,
    purpose: 'lead',
    tokenHash: 'hash',
    email: null,
    expiresAt: new Date('2026-10-03T00:00:00Z'),
    usedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-09-26T04:00:00Z'),
  };
}

function estimateRecord(): EstimateRecord {
  return {
    id: ESTIMATE_ID,
    projectType: 'new_build',
    addressKey: ADDRESS_KEY,
    inputs: { sqft: 2200, tier: 'standard', garage: 'double', basement: 'unfinished' },
    figures: {
      build: RANGE,
      total: { low: 700000, base: 780000, high: 860000 },
      land: { value: 330000 },
    },
    rows: [{ key: 'site-prep', label: 'Site prep', range: { low: 10000, base: 12000, high: 14000 } }],
    costDataVersion: 'placeholder-1',
    createdAt: new Date('2026-09-26T04:00:00Z'),
    narrative: null,
    narrativeGeneratedAt: null,
    assumptions: null,
  };
}

function propertyRecord() {
  return {
    addressKey: ADDRESS_KEY,
    address: '123 Elm St NW',
    community: 'Hillhurst',
    lotSqft: 5000,
    zoning: 'R-CG',
    assessedValue: 330000,
    assessmentYear: 2026,
    yearBuilt: 1990,
    dataAsOf: '2026-01-01',
    stale: false,
  };
}

interface Fakes {
  service: ReportService;
  inserted: NewReportSnapshot[];
}

function fakes(opts?: {
  link?: MagicLinkRecord | null;
  latest?: ReportSnapshotRecord | null;
}): Fakes {
  const inserted: NewReportSnapshot[] = [];
  const snapshots: ReportSnapshotStore = {
    findLatestByEstimateId: async () => opts?.latest ?? null,
    insert: async (snapshot) => {
      inserted.push(snapshot);
      const now = new Date('2026-09-26T05:00:00Z');
      return { ...snapshot, preparedAt: now, createdAt: now } as ReportSnapshotRecord;
    },
  };
  const magicLinks: MagicLinkStore = {
    findByToken: async (token: string) =>
      token === TOKEN ? (opts?.link === undefined ? liveLink() : opts.link) : null,
    issue: async () => ({ id: 'x', token: 'y', expiresAt: new Date() }),
  } as unknown as MagicLinkStore;
  const leads: LeadStore = {
    findById: async (id: string) => (id === LEAD_ID ? LEAD : null),
    findNewestEstimateIdByEmailAndAddress: async () => ({
      estimateId: ESTIMATE_ID,
      createdAt: new Date('2026-09-26T04:00:00Z'),
    }),
  } as unknown as LeadStore;
  const estimates: EstimateStore = {
    save: async () => {},
    findById: async (id: string) => (id === ESTIMATE_ID ? estimateRecord() : null),
  } as unknown as EstimateStore;
  const properties = {
    getProperty: async () => propertyRecord(),
  } as unknown as PropertyService;
  const service = createReportService({
    magicLinks,
    leads,
    estimates,
    snapshots,
    properties,
    costData: PLACEHOLDER_COST_DATA,
    allowDraftCostData: true,
    clock: () => new Date('2026-09-26T05:00:00Z'),
  });
  return { service, inserted };
}

describe('report service — getReport', () => {
  it('materializes version 1 from the estimate row when no snapshot exists', async () => {
    const { service, inserted } = fakes();
    const result = await service.getReport(TOKEN);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.version).toBe(1);
    expect(inserted[0]?.leadId).toBe(LEAD_ID);
    expect(result.snapshotId).toBe(inserted[0]?.id);
    expect(result.estimateId).toBe(ESTIMATE_ID);
    expect(result.version).toBe(1);
    expect(result.buildRange).toEqual(RANGE);
    expect(result.landValue).toEqual({ value: 330000 });
    expect(result.inputs).toMatchObject({ sqft: 2200, tier: 'standard' });
    expect(result.updatedAt).toBeUndefined();
  });

  it('returns the latest snapshot without inserting when one exists', async () => {
    const record: ReportSnapshotRecord = {
      id: 'ssssssss-ssss-4sss-8sss-ssssssssssss',
      estimateId: ESTIMATE_ID,
      leadId: LEAD_ID,
      inputs: { sqft: 2200, tier: 'standard', garage: 'double', basement: 'unfinished' },
      buildRange: RANGE,
      totalRange: { low: 700000, base: 780000, high: 860000 },
      landValue: { value: 330000 },
      rows: [],
      narrative: '',
      assumptions: null,
      projectType: 'new_build',
      renoInputs: null,
      version: 1,
      preparedAt: new Date('2026-09-26T05:00:00Z'),
      updatedAt: null,
      createdAt: new Date('2026-09-26T05:00:00Z'),
    };
    const { service, inserted } = fakes({ latest: record });
    const result = await service.getReport(TOKEN);
    expect(inserted).toHaveLength(0);
    expect(result.snapshotId).toBe(record.id);
    expect(result.version).toBe(1);
  });

  it('answers 404 for unknown tokens', async () => {
    const { service } = fakes();
    await expect(service.getReport('bogus-token')).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it('answers 404 for expired tokens (same response as unknown — no oracle)', async () => {
    const expired = { ...liveLink(), expiresAt: new Date('2026-01-01T00:00:00Z') };
    const { service } = fakes({ link: expired });
    await expect(service.getReport(TOKEN)).rejects.toMatchObject({ status: 404 });
  });
});

describe('report service — createRevision', () => {
  it('appends a new version with the revised tier', async () => {
    const { service, inserted } = fakes();
    const result = await service.createRevision(TOKEN, { tier: 'luxury' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.version).toBe(1);
    expect(result.version).toBe(1);
    expect(result.inputs.tier).toBe('luxury');
    expect(result.inputs.sqft).toBe(2200);
    expect(result.updatedAt).toBeDefined();
    // Luxury must cost more than the standard v1 figures.
    expect(result.buildRange.low).toBeGreaterThan(RANGE.low);
  });

  it('appends a new version with revised sqft', async () => {
    const { service } = fakes();
    const result = await service.createRevision(TOKEN, { sqft: 2600 });
    expect(result.inputs.sqft).toBe(2600);
    expect(result.buildRange.low).toBeGreaterThan(RANGE.low);
  });

  it('stacks versions monotonically on top of the latest snapshot', async () => {
    const { service, inserted } = fakes();
    const v1 = await service.createRevision(TOKEN, { tier: 'premium' });
    const record: ReportSnapshotRecord = {
      id: v1.snapshotId,
      estimateId: ESTIMATE_ID,
      leadId: LEAD_ID,
      inputs: { sqft: 2200, tier: 'premium', garage: 'double', basement: 'unfinished' },
      buildRange: v1.buildRange,
      totalRange: v1.totalRange,
      landValue: { value: 330000 },
      rows: [],
      narrative: '',
      assumptions: null,
      projectType: 'new_build',
      renoInputs: null,
      version: 1,
      preparedAt: new Date('2026-09-26T05:00:00Z'),
      updatedAt: new Date('2026-09-26T05:00:00Z'),
      createdAt: new Date('2026-09-26T05:00:00Z'),
    };
    const { service: s2 } = fakes({ latest: record });
    const v2 = await s2.createRevision(TOKEN, { sqft: 2400 });
    expect(v2.version).toBe(2);
    expect(v2.inputs.sqft).toBe(2400);
    expect(v2.inputs.tier).toBe('premium');
    expect(inserted).toHaveLength(1);
  });

  it('rejects an empty revision body (tier or sqft required)', async () => {
    const { service } = fakes();
    await expect(service.createRevision(TOKEN, {})).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
  });

  it('answers 404 for unknown tokens', async () => {
    const { service } = fakes();
    await expect(
      service.createRevision('bogus-token', { tier: 'luxury' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('report route', () => {
  it('delegates get/createRevision to the service', async () => {
    const { service } = fakes();
    const route = createReportRoute({ reports: service });
    const report = await route.get(TOKEN);
    expect(report.estimateId).toBe(ESTIMATE_ID);
    const revision = await route.createRevision(TOKEN, { tier: 'luxury' });
    expect(revision.inputs.tier).toBe('luxury');
  });
});

describe('report contract conformance', () => {
  it('report and revision responses validate against the contracts ReportSnapshot schema', async () => {
    const { service } = fakes();
    const route = createReportRoute({ reports: service });
    for (const result of [
      await route.get(TOKEN),
      await route.createRevision(TOKEN, { tier: 'luxury' }),
    ]) {
      const parsed = ReportSnapshotSchema.safeParse(JSON.parse(JSON.stringify(result)));
      expect(parsed.success).toBe(true);
    }
  });
});
