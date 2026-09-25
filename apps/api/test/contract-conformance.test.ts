/**
 * APIMCP-04 — contract conformance tests.
 *
 * One shared fixture
 * (`packages/cost-engine/test/fixtures/api-contract.json`, 14 cases across
 * project types × tiers × edge square-footages) is run through every
 * estimate surface; each surface must produce byte-identical outputs
 * (JSON-serialized comparison) with an identical `cost_data_version`.
 *
 * Legs:
 *  (a) web handler path — the estimate route (`createEstimateRoute`), the
 *      handler the web UI exercises via POST /api/v1/estimate;
 *  (b) REST handler — the estimate service (`createEstimateService`) called
 *      directly, the same code the versioned public API serves;
 *  (c) MCP tool — SKIPPED until APIMCP-06 lands `packages/mcp`
 *      (see the skipped test below).
 *
 * The fixture's `expected` outputs are generated from the engine by
 *   npm run contract:regen --workspace @feasly/api
 * (CONTRACT_REGEN=1). The fixture file carries a SHA-256 checksum
 * (`api-contract.sha256`); the checksum is verified before any case runs,
 * so a hand-edited fixture fails loudly instead of silently redefining
 * the contract.
 *
 * MAINTENANCE CONTRACT: `engineComparable()` below mirrors the service's
 * private `toResponse`/`toRenoResponse` mapping on purpose — it is the
 * INDEPENDENT oracle. If the service's mapping changes, update
 * `engineComparable()` to match and re-run the regen. If the ENGINE
 * changes, just re-run the regen. Either way this test fails loudly until
 * the fixture is regenerated.
 *
 * Mutation check (2026-09-25): temporarily widened the standard-tier
 * new-build base spread in a scratch copy of the cost data; all 14 cases
 * failed with output mismatches as required; reverted.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_COST_DATA,
  createEstimate,
  createRenoEstimate,
} from '@feasly/cost-engine';
import type {
  EngineInput,
  RenoInput,
} from '@feasly/cost-engine';
import type { EstimateResponse } from '@feasly/contracts';
import { ESTIMATE_DISCLAIMER } from '@feasly/contracts';
import { createEstimateRoute } from '../src/routes/estimate.route';
import { createEstimateService } from '../src/services/estimate.service';
import { expectEstimateResponse, mockCommunityStatsService } from './helpers/mock-community-stats';
import type {
  EstimateRecord,
  EstimateStore,
} from '../src/services/estimate.store';

/** Deterministic subset of EstimateResponse: everything but the volatile IDs. */
type ComparableEstimate = Omit<EstimateResponse, 'estimateId' | 'createdAt'>;

interface FixtureCase {
  readonly id: string;
  readonly request: unknown;
  /** Null until the regen script fills it in. */
  readonly expected: ComparableEstimate | null;
}

interface FixtureFile {
  readonly version: number;
  readonly costDataVersion: string;
  readonly cases: readonly FixtureCase[];
}

// __dirname (not import.meta): the api tsconfig module setting disallows
// import.meta — same convention as the other api tests.
const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'cost-engine',
  'test',
  'fixtures',
  'api-contract.json',
);
const CHECKSUM_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'cost-engine',
  'test',
  'fixtures',
  'api-contract.sha256',
);

const REGEN = process.env.CONTRACT_REGEN === '1';

/** Banned key fragments: anything smelling like a unit rate or a margin. */
const BANNED_KEY_FRAGMENTS = [
  'persqft',
  'per_sqft',
  'unitrate',
  'unit_rate',
  'percent',
  'margin',
];

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function loadFixture(): { file: FixtureFile; bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  return { file: JSON.parse(bytes.toString('utf8')) as FixtureFile, bytes };
}

/**
 * Independent oracle: runs the engine directly and maps the result to the
 * contract's comparable shape. Mirrors the service's private
 * `toResponse`/`toRenoResponse` mapping field-for-field AND key-for-key
 * (JSON key order must match for the byte-identical comparison).
 */
function engineComparable(request: unknown): ComparableEstimate {
  const req = request as {
    projectType?: string;
    property?: {
      addressKey: string;
      assessedLandValue: number;
      lotSizeSqft: number;
      zoning: string;
    };
    scope?: {
      buildSqft: number;
      tier: 'standard' | 'premium' | 'luxury';
      garage: 'none' | 'double' | 'triple';
      basement: 'unfinished' | 'finished';
    };
    addressKey?: string;
    renoType?: 'extensive' | 'addition' | 'basement' | 'combined';
    renoSqft?: number;
    tier?: 'standard' | 'premium' | 'luxury';
    underpinning?: boolean;
  };

  if (req.projectType === 'renovation') {
    const renoInput: RenoInput = {
      renoType: req.renoType!,
      renoSqft: req.renoSqft!,
      tier: req.tier!,
      underpinning: req.underpinning ?? false,
    };
    const result = createRenoEstimate(renoInput, PLACEHOLDER_COST_DATA);
    const range = {
      low: result.total.low,
      base: result.total.base,
      high: result.total.high,
    };
    // Key order mirrors the service's toRenoResponse (minus estimateId/createdAt).
    return {
      addressKey: req.addressKey!,
      projectType: 'renovation',
      inputs: {
        sqft: req.renoSqft!,
        tier: req.tier!,
        garage: 'none',
        basement: 'unfinished',
      },
      renoInputs: {
        projectType: 'renovation',
        renoType: req.renoType!,
        renoSqft: req.renoSqft!,
        tier: req.tier!,
        underpinning: req.underpinning ?? false,
      },
      figures: { build: range, total: range, land: { value: 0 } },
      rows: result.rows.map((row) => ({
        key: row.key,
        label: row.label,
        range: { low: row.range.low, base: row.range.base, high: row.range.high },
      })),
      assumptions: result.assumptions,
      visibility: { land: 'not_applicable', build: 'blurred', total: 'blurred' },
      costDataVersion: result.costDataVersion,
      disclaimer: ESTIMATE_DISCLAIMER,
    };
  }

  // New build: the engine's input is the strict subset it understands —
  // addressKey and garage/basement travel in persisted inputs, not the math.
  const engineInput: EngineInput = {
    property: {
      assessedLandValue: req.property!.assessedLandValue,
      lotSizeSqft: req.property!.lotSizeSqft,
      zoning: req.property!.zoning,
    },
    scope: {
      buildSqft: req.scope!.buildSqft,
      tier: req.scope!.tier,
    },
  };
  const result = createEstimate(engineInput, PLACEHOLDER_COST_DATA);
  const toRange = (band: { low: number; base: number; high: number }) => ({
    low: band.low,
    base: band.base,
    high: band.high,
  });
  // Key order mirrors the service's toResponse (minus estimateId/createdAt).
  return {
    addressKey: req.property!.addressKey,
    inputs: {
      sqft: req.scope!.buildSqft,
      tier: req.scope!.tier,
      garage: req.scope!.garage,
      basement: req.scope!.basement,
    },
    figures: {
      build: toRange(result.totals.build),
      total: toRange(result.totals.total),
      land: { value: result.totals.land.value },
    },
    rows: result.rows.map((row) => ({
      key: row.key,
      label: row.label,
      range: toRange(row.range),
    })),
    costDataVersion: result.costDataVersion,
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

/** Strips the volatile envelope (random ID, wall-clock time) for comparison. */
function stripVolatile(response: EstimateResponse): ComparableEstimate {
  const { estimateId: _id, createdAt: _at, ...comparable } = response;
  return comparable;
}

/** In-memory EstimateStore: the harness never touches a real database. */
function createInMemoryEstimateStore(): EstimateStore {
  const records = new Map<string, EstimateRecord>();
  return {
    async save(record: EstimateRecord): Promise<void> {
      records.set(record.id, record);
    },
    async findById(id: string): Promise<EstimateRecord | null> {
      return records.get(id) ?? null;
    },
  };
}

if (REGEN) {
  describe('contract fixture regen (CONTRACT_REGEN=1)', () => {
    it('regenerates expected outputs from the engine and rewrites the checksum', () => {
      const { file } = loadFixture();
      const cases = file.cases.map((c) => ({
        ...c,
        expected: engineComparable(c.request),
      }));
      const next: FixtureFile = {
        version: 1,
        costDataVersion: PLACEHOLDER_COST_DATA.version,
        cases,
      };
      const json = `${JSON.stringify(next, null, 2)}\n`;
      writeFileSync(FIXTURE_PATH, json);
      writeFileSync(CHECKSUM_PATH, `${sha256Hex(json)}\n`);
    });
  });
} else {
  describe('contract conformance (APIMCP-04)', () => {
    const { file, bytes } = loadFixture();

    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: createInMemoryEstimateStore(),
      allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
    const route = createEstimateRoute({ estimate: service });

    it('rejects hand-edited fixtures (SHA-256 checksum)', () => {
      const recorded = readFileSync(CHECKSUM_PATH, 'utf8').trim();
      expect(sha256Hex(bytes)).toBe(recorded);
    });

    it('pins the bundled cost-data version', () => {
      expect(file.costDataVersion).toBe(PLACEHOLDER_COST_DATA.version);
    });

    it('covers at least 12 cases', () => {
      expect(file.cases.length).toBeGreaterThanOrEqual(12);
    });

    function expectConformance(
      leg: string,
      actual: ComparableEstimate,
      fixtureCase: FixtureCase,
    ): void {
      expect(
        fixtureCase.expected,
        `fixture case '${fixtureCase.id}' has no expected output — run: npm run contract:regen --workspace @feasly/api`,
      ).not.toBeNull();
      // Byte-identical outputs: JSON-serialized comparison.
      expect(JSON.stringify(actual)).toBe(JSON.stringify(fixtureCase.expected));
      // Identical cost_data_version, asserted explicitly as well.
      expect(actual.costDataVersion).toBe(file.costDataVersion);
      // Deny-list scan: no rates or margins leak into any surface's output.
      const keys = collectKeys(actual).map((k) => k.toLowerCase());
      for (const fragment of BANNED_KEY_FRAGMENTS) {
        expect(
          keys.filter((k) => k.includes(fragment)),
          `leg ${leg} case '${fixtureCase.id}' leaked a '${fragment}' key`,
        ).toEqual([]);
      }
    }

    for (const fixtureCase of file.cases) {
      describe(`case ${fixtureCase.id}`, () => {
        it('leg (a) — web handler path matches the fixture', async () => {
          const response = expectEstimateResponse(await route.handle(fixtureCase.request));
          expectConformance('(a) web', stripVolatile(response), fixtureCase);
        });

        it('leg (b) — REST handler matches the fixture', async () => {
          const response = expectEstimateResponse(await service.estimate(fixtureCase.request));
          expectConformance('(b) REST', stripVolatile(response), fixtureCase);
        });

        // APIMCP-06: the MCP server does not exist yet (packages/mcp holds
        // only a package.json on main). When `estimate_project` lands, add
        // leg (c) here asserting deep-equal outputs against the same fixture
        // cases — the tool must call the shared engine/services, never its
        // own cost math.
        it.skip('leg (c) — MCP tool matches the fixture (pending APIMCP-06)', () => {});
      });
    }
  });
}
