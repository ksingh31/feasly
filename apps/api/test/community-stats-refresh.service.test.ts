/**
 * Community-stats refresh service tests (neighbourhood/05).
 *
 * The Socrata source is faked at the interface boundary (no network); the
 * stats store is faked at the service boundary (not Drizzle internals).
 * Tests cover: aggregate mapping on fixtures, the < 10-record skip
 * threshold (never zero-filled), per-row failures not killing the batch,
 * idempotency (run twice → same upserts), retry on transient source
 * failure, 2-consecutive-failures → alert, and recovery → all-clear.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createCommunityStatsRefreshService,
  type CommunityStatsRefreshServiceDeps,
  type CommunityStatsSource,
  type CommunityStatsRefreshResult,
} from '../src/services/community-stats-refresh.service';
import type {
  CommunityStatsService,
  CommunityStatRecord,
} from '../src/services/community-stats.service';

/** One Socrata aggregate row as the API returns it (strings for numbers). */
function socrataRow(
  commName: string,
  count: number,
  avgValue: number,
  avgLot: number | null = 5000,
) {
  return {
    comm_name: commName,
    count_assessed_value: String(count),
    avg_assessed_value: String(avgValue),
    avg_land_size_sf: avgLot === null ? null : String(avgLot),
  };
}

function makeSource(
  rows: unknown[],
  overrides: Partial<CommunityStatsSource> = {},
): CommunityStatsSource & { calls: { latestRollYear: number; fetchRows: number } } {
  const calls = { latestRollYear: 0, fetchRows: 0 };
  return {
    calls,
    latestRollYear: async () => {
      calls.latestRollYear++;
      return '2025';
    },
    fetchAggregateRows: async () => {
      calls.fetchRows++;
      return rows;
    },
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<CommunityStatsRefreshServiceDeps> = {},
): CommunityStatsRefreshServiceDeps & {
  upserted: CommunityStatRecord[][];
  warnings: string[];
  failing: { consecutiveFailures: number; firstFailureAt: Date }[];
  recovered: number;
} {
  const upserted: CommunityStatRecord[][] = [];
  const warnings: string[] = [];
  const failing: { consecutiveFailures: number; firstFailureAt: Date }[] = [];
  let recovered = 0;
  const stats: CommunityStatsService = {
    getBySlug: vi.fn(),
    upsertMany: vi.fn(async (rows: readonly CommunityStatRecord[]) => {
      upserted.push([...rows]);
      return rows.length;
    }),
  };
  return {
    upserted,
    warnings,
    failing,
    get recovered() {
      return recovered;
    },
    stats,
    source: makeSource([]),
    minAssessmentCount: 10,
    alertAfterConsecutiveFailures: 2,
    onRefreshFailing: async (ctx) => {
      failing.push(ctx);
    },
    onRefreshRecovered: async () => {
      recovered++;
    },
    clock: () => new Date('2026-10-01T00:00:00Z'),
    retryPolicy: { maxAttempts: 3, baseDelayMs: 0 },
    sleep: async () => {},
    logWarning: (message: string) => {
      warnings.push(message);
    },
    ...overrides,
  };
}

const FIXTURE_ROWS = [
  socrataRow('Mount Pleasant', 3210, 685000.4, 5432.7),
  socrataRow('Bridgeland/Riverside', 1980, 712500, null),
];

describe('community-stats refresh service', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps({ source: makeSource(FIXTURE_ROWS) });
  });

  it('maps Socrata aggregates to canonical records and upserts them', async () => {
    const service = createCommunityStatsRefreshService(deps);
    const result: CommunityStatsRefreshResult = await service.runRefreshCycle();

    expect(result.refreshed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.rollYear).toBe('2025');
    expect(result.refreshedAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(result.consecutiveFailures).toBe(0);

    expect(deps.upserted).toHaveLength(1);
    const records = deps.upserted[0]!;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      slug: 'mount-pleasant',
      name: 'Mount Pleasant',
      avgAssessedValue: 685000, // rounded to whole dollars
      assessmentCount: 3210,
      avgLotSqft: 5433, // rounded
      refreshedAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(records[1]).toMatchObject({
      slug: 'bridgeland-riverside',
      avgLotSqft: null,
    });
  });

  it('skips communities below the assessment-count threshold — never zero-filled', async () => {
    deps = makeDeps({
      source: makeSource([
        socrataRow('Tiny Hamlet', 9, 400000),
        socrataRow('Mount Pleasant', 3210, 685000),
      ]),
    });
    const service = createCommunityStatsRefreshService(deps);
    const result = await service.runRefreshCycle();

    expect(result.refreshed).toBe(1);
    expect(result.skipped).toBe(1);
    // Only the healthy community was written.
    expect(deps.upserted[0]).toHaveLength(1);
    expect(deps.upserted[0]![0]!.slug).toBe('mount-pleasant');
    // The skip is loud, not silent.
    expect(deps.warnings).toHaveLength(1);
    expect(deps.warnings[0]).toContain('Tiny Hamlet');
    expect(deps.warnings[0]).toContain('9 assessments');
  });

  it('a community at exactly the threshold is kept', async () => {
    deps = makeDeps({
      source: makeSource([socrataRow('Borderline', 10, 500000)]),
    });
    const service = createCommunityStatsRefreshService(deps);
    const result = await service.runRefreshCycle();
    expect(result.refreshed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(deps.warnings).toHaveLength(0);
  });

  it('one unusable row does not kill the batch', async () => {
    deps = makeDeps({
      source: makeSource([
        { comm_name: '', count_assessed_value: '5', avg_assessed_value: '1' }, // blank name
        { comm_name: 'No Count', count_assessed_value: '0', avg_assessed_value: '1' }, // zero count
        socrataRow('Mount Pleasant', 3210, 685000),
      ]),
    });
    const service = createCommunityStatsRefreshService(deps);
    const result = await service.runRefreshCycle();

    expect(result.refreshed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(deps.upserted[0]).toHaveLength(1);
  });

  it('is idempotent: run twice → same upsert payload, no duplicates', async () => {
    const service = createCommunityStatsRefreshService(deps);
    const first = await service.runRefreshCycle();
    const second = await service.runRefreshCycle();

    expect(first.refreshed).toBe(2);
    expect(second.refreshed).toBe(2);
    expect(deps.upserted).toHaveLength(2);
    // Same slugs, same values — the upsert (not insert) makes this safe.
    expect(deps.upserted[0]).toEqual(deps.upserted[1]);
  });

  it('retries a transient source failure and still succeeds', async () => {
    let attempts = 0;
    deps = makeDeps({
      source: makeSource(FIXTURE_ROWS, {
        latestRollYear: async () => {
          attempts++;
          if (attempts < 3) throw new Error('Socrata unreachable: timeout');
          return '2025';
        },
      }),
    });
    const service = createCommunityStatsRefreshService(deps);
    const result = await service.runRefreshCycle();
    expect(result.refreshed).toBe(2);
    expect(attempts).toBe(3);
    expect(deps.failing).toHaveLength(0);
  });

  it('fires the alert after 2 consecutive failures, with the streak start', async () => {
    const boom = new Error('Socrata unreachable: timeout');
    deps = makeDeps({
      source: makeSource([], {
        latestRollYear: async () => {
          throw boom;
        },
      }),
      clock: (() => {
        const times = [
          new Date('2026-10-01T00:00:00Z'),
          new Date('2026-11-01T00:00:00Z'),
          new Date('2026-12-01T00:00:00Z'),
        ];
        let i = 0;
        return () => times[Math.min(i++, times.length - 1)]!;
      })(),
    });
    const service = createCommunityStatsRefreshService(deps);

    // First failure: below the threshold — no alert yet.
    await expect(service.runRefreshCycle()).rejects.toThrow('Socrata unreachable');
    expect(deps.failing).toHaveLength(0);

    // Second consecutive failure: alert fires, anchored at the first failure.
    await expect(service.runRefreshCycle()).rejects.toThrow('Socrata unreachable');
    expect(deps.failing).toHaveLength(1);
    expect(deps.failing[0]!.consecutiveFailures).toBe(2);
    expect(deps.failing[0]!.firstFailureAt).toEqual(
      new Date('2026-10-01T00:00:00Z'),
    );

    // Third failure: still failing, but the alert is not re-fired (dedupe
    // is the ops-alert service's job; the hook fires once per streak).
    await expect(service.runRefreshCycle()).rejects.toThrow('Socrata unreachable');
    expect(deps.failing).toHaveLength(1);
  });

  it('recovery after a failing streak fires the all-clear and resets the count', async () => {
    let shouldFail = true;
    deps = makeDeps({
      source: makeSource(FIXTURE_ROWS, {
        latestRollYear: async () => {
          if (shouldFail) throw new Error('Socrata unreachable: timeout');
          return '2025';
        },
      }),
    });
    const service = createCommunityStatsRefreshService(deps);

    await expect(service.runRefreshCycle()).rejects.toThrow();
    await expect(service.runRefreshCycle()).rejects.toThrow();
    expect(deps.failing).toHaveLength(1);
    expect(deps.recovered).toBe(0);

    shouldFail = false;
    const result = await service.runRefreshCycle();
    expect(result.refreshed).toBe(2);
    expect(result.consecutiveFailures).toBe(0);
    expect(deps.recovered).toBe(1);

    // A later failure starts a NEW streak — the alert re-arms.
    shouldFail = true;
    await expect(service.runRefreshCycle()).rejects.toThrow();
    expect(deps.failing).toHaveLength(1); // still one: new streak below threshold
    await expect(service.runRefreshCycle()).rejects.toThrow();
    expect(deps.failing).toHaveLength(2);
  });

  it('a single failure between successes never alerts', async () => {
    let failCycle = false;
    deps = makeDeps({
      source: makeSource(FIXTURE_ROWS, {
        latestRollYear: async () => {
          // Fails every retry attempt of the cycle (a real outage, not a blip).
          if (failCycle) throw new Error('Socrata unreachable: blip');
          return '2025';
        },
      }),
    });
    const service = createCommunityStatsRefreshService(deps);
    await service.runRefreshCycle();
    failCycle = true;
    await expect(service.runRefreshCycle()).rejects.toThrow();
    failCycle = false;
    await service.runRefreshCycle();
    expect(deps.failing).toHaveLength(0);
    expect(deps.recovered).toBe(0); // never entered the failing state
  });
});
