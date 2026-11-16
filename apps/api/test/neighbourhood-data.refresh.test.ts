/**
 * Neighbourhood refresh job (#773) against PGlite (migration 0057).
 *
 * AC1: a fake provider proves the job writes, re-runs idempotently, and
 * keeps the old data on failure. Also: monthly due logic, resume after a
 * partial run, one ops alert after 3 days of failures + one all-clear,
 * config switch replaces rows, telemetry per provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NEIGHBOURHOOD_PROVIDER_NAMES,
  type AmenityRecord,
  type NeighbourhoodProvider,
  type NeighbourhoodProviders,
  type SchoolRecord,
} from '../src/services/neighbourhood-data/providers';
import { createDrizzleNeighbourhoodDataStore } from '../src/services/neighbourhood-data/neighbourhood-data.store';
import {
  createNeighbourhoodRefreshService,
  isProviderDue,
  lastScheduledBoundary,
  type NeighbourhoodRefreshEvent,
} from '../src/services/neighbourhood-data/neighbourhood-refresh.service';
import { createTestDb, type TestDb } from './pglite-db';

const DAY = 86_400_000;

function school(id: string, name = `School ${id}`): SchoolRecord {
  return { externalId: id, name, board: 'CBE', grades: 'K-6', lat: 51.01, lng: -114.1, data: { address: `${id} ST SW` } };
}

/** Controllable fake provider: returns `rows`, or throws when `fail` is set. */
function fakeProvider<T>(implementation: string, rows: T[]) {
  const state = { rows, fail: false, calls: 0, implementation };
  const provider: NeighbourhoodProvider<T> = {
    get implementation() {
      return state.implementation;
    },
    async fetchAll() {
      state.calls++;
      if (state.fail) throw new Error('source down');
      return state.rows;
    },
  };
  return { provider, state };
}

function none<T>(): NeighbourhoodProvider<T, 'none'> {
  return { implementation: 'none', fetchAll: async () => [] };
}

describe('neighbourhood refresh job (#773)', () => {
  let testDb: TestDb;
  let clockNow: Date;
  let alerts: Array<{ provider: string; consecutiveFailures: number; firstFailureAt: Date }>;
  let recoveries: number;
  let events: NeighbourhoodRefreshEvent[];
  let schoolsFake: ReturnType<typeof fakeProvider<SchoolRecord>>;
  let amenitiesFake: ReturnType<typeof fakeProvider<AmenityRecord>>;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  beforeEach(async () => {
    await testDb.exec(
      'DELETE FROM schools; DELETE FROM amenities; DELETE FROM community_living_metrics; DELETE FROM neighbourhood_refresh_state;',
    );
    clockNow = new Date('2026-11-16T07:00:00Z');
    alerts = [];
    recoveries = 0;
    events = [];
    schoolsFake = fakeProvider<SchoolRecord>('fake-free', [school('1'), school('2')]);
    amenitiesFake = fakeProvider<AmenityRecord>('fake-free', [
      { externalId: 'park-1', category: 'Park', name: 'Park One', lat: 51.0, lng: -114.1, data: {} },
    ]);
  });

  function makeService() {
    const providers = {
      schoolDirectory: schoolsFake.provider,
      schoolDesignation: none(),
      schoolRatings: none(),
      reviews: none(),
      amenities: amenitiesFake.provider,
      commute: none(),
    } as unknown as NeighbourhoodProviders;
    return createNeighbourhoodRefreshService({
      providers,
      store: createDrizzleNeighbourhoodDataStore({ db: testDb.db }),
      refreshDayOfMonth: 1,
      alertAfterFailureDays: 3,
      onFailing: async (args) => {
        alerts.push(args);
      },
      onRecovered: async () => {
        recoveries++;
      },
      onEvent: (e) => events.push(e),
      clock: () => clockNow,
      logWarning: () => {},
    });
  }

  const schoolNames = async () =>
    (await testDb.rows<{ name: string }>('select name from schools order by id')).map((r) => r.name);

  it('AC1: writes a snapshot, re-runs idempotently, and keeps old data on failure', async () => {
    const service = makeService();
    const first = await service.refreshNow('school-directory');
    expect(first).toMatchObject({ outcome: 'ok', rowsChanged: 2, rowsPruned: 0, rowsTotal: 2 });
    expect(await schoolNames()).toEqual(['School 1', 'School 2']);

    // Same data again → no changes, no duplicates.
    const second = await service.refreshNow('school-directory');
    expect(second).toMatchObject({ outcome: 'ok', rowsChanged: 0, rowsPruned: 0, rowsTotal: 2 });
    expect(await schoolNames()).toEqual(['School 1', 'School 2']);

    // One row changes, one disappears, one is new → counted and pruned.
    schoolsFake.state.rows = [school('1', 'School 1 renamed'), school('3')];
    const third = await service.refreshNow('school-directory');
    expect(third).toMatchObject({ outcome: 'ok', rowsChanged: 2, rowsPruned: 1, rowsTotal: 2 });
    expect(await schoolNames()).toEqual(['School 1 renamed', 'School 3']);

    // Source down → failure recorded, previous rows untouched.
    schoolsFake.state.fail = true;
    const failed = await service.refreshNow('school-directory');
    expect(failed).toMatchObject({ outcome: 'failed', error: 'Error', consecutiveFailures: 1 });
    expect(await schoolNames()).toEqual(['School 1 renamed', 'School 3']);

    // A real source returning nothing is a failure too — never wipes the table.
    schoolsFake.state.fail = false;
    schoolsFake.state.rows = [];
    const empty = await service.refreshNow('school-directory');
    expect(empty).toMatchObject({ outcome: 'failed', error: 'EmptySnapshotError', consecutiveFailures: 2 });
    expect(await schoolNames()).toEqual(['School 1 renamed', 'School 3']);
  });

  it('a write that fails mid-snapshot rolls back entirely (old data kept)', async () => {
    const service = makeService();
    await service.refreshNow('school-directory');
    // 600 rows → two batches; the last row violates NOT NULL (name).
    const rows = Array.from({ length: 600 }, (_, i) => school(`n${i}`));
    rows[599] = { ...rows[599]!, name: null as unknown as string };
    schoolsFake.state.rows = rows;
    const result = await service.refreshNow('school-directory');
    expect(result.outcome).toBe('failed');
    expect(await schoolNames()).toEqual(['School 1', 'School 2']);
  });

  it('timer runs only due providers: monthly on the configured day, skips "none" implementations', async () => {
    const service = makeService();
    const run1 = await service.runDue();
    expect(run1.results.map((r) => `${r.provider}:${r.outcome}`)).toEqual([
      'school-directory:ok',
      'school-designation:skipped',
      'school-ratings:skipped',
      'reviews:skipped',
      'amenities:ok',
      'commute:skipped',
    ]);
    // Later the same month → nothing due, no provider called.
    clockNow = new Date('2026-11-28T07:00:00Z');
    const callsBefore = schoolsFake.state.calls;
    expect((await service.runDue()).results).toHaveLength(0);
    expect(schoolsFake.state.calls).toBe(callsBefore);
    // Next month's refresh day → due again.
    clockNow = new Date('2026-12-01T07:00:00Z');
    expect((await service.runDue()).results).toHaveLength(NEIGHBOURHOOD_PROVIDER_NAMES.length);
  });

  it('resumes: a provider that failed is retried on the next daily tick while finished ones are not', async () => {
    const service = makeService();
    amenitiesFake.state.fail = true;
    await service.runDue();
    expect(amenitiesFake.state.calls).toBe(1);
    const schoolCalls = schoolsFake.state.calls;

    clockNow = new Date(clockNow.getTime() + DAY);
    amenitiesFake.state.fail = false;
    const next = await service.runDue();
    expect(next.results.map((r) => r.provider)).toEqual(['amenities']);
    expect(next.results[0]!.outcome).toBe('ok');
    expect(schoolsFake.state.calls).toBe(schoolCalls);
    expect(await testDb.rows('select id from amenities')).toHaveLength(1);
  });

  it('raises ONE ops alert after 3 days of failures, then one all-clear on recovery', async () => {
    const service = makeService();
    await service.runDue(); // healthy baseline
    clockNow = new Date('2026-12-01T07:00:00Z');
    amenitiesFake.state.fail = true;
    const start = clockNow;
    for (let day = 0; day <= 5; day++) {
      clockNow = new Date(start.getTime() + day * DAY);
      await service.runDue();
      // Days 0..2 → under 3 days of failure, no alert yet.
      expect(alerts).toHaveLength(day >= 3 ? 1 : 0);
    }
    expect(alerts[0]).toMatchObject({ provider: 'amenities', consecutiveFailures: 4, firstFailureAt: start });
    // Old amenities still there throughout.
    expect(await testDb.rows('select id from amenities')).toHaveLength(1);

    amenitiesFake.state.fail = false;
    clockNow = new Date(start.getTime() + 6 * DAY);
    await service.runDue();
    expect(recoveries).toBe(1);
    expect(alerts).toHaveLength(1);
  });

  it('switching implementation by config replaces the old source rows on its first refresh', async () => {
    await makeService().runDue();
    // Same provider interface, new implementation (e.g. a paid source).
    schoolsFake.state.implementation = 'fake-paid';
    schoolsFake.state.rows = [school('p1', 'Paid School')];
    const run = await makeService().runDue();
    // Due immediately because the implementation changed.
    expect(run.results.map((r) => r.provider)).toContain('school-directory');
    const rows = await testDb.rows<{ id: string; source: string }>('select id, source from schools');
    expect(rows).toEqual([{ id: 'fake-paid:p1', source: 'fake-paid' }]);
  });

  it('emits telemetry per provider run and per job run (counts only)', async () => {
    const service = makeService();
    amenitiesFake.state.fail = true;
    await service.runDue();
    const providerEvents = events.filter((e) => e.event === 'provider_refresh');
    expect(providerEvents).toHaveLength(NEIGHBOURHOOD_PROVIDER_NAMES.length);
    expect(providerEvents.find((e) => 'provider' in e && e.provider === 'school-directory')).toMatchObject({
      trigger: 'timer',
      outcome: 'ok',
      rowsChanged: 2,
    });
    expect(providerEvents.find((e) => 'provider' in e && e.provider === 'amenities')).toMatchObject({
      outcome: 'failed',
      consecutiveFailures: 1,
    });
    expect(events.at(-1)).toEqual({ event: 'run', trigger: 'timer', ran: 6, ok: 1, failed: 1, skipped: 4 });
  });
});

describe('monthly schedule helpers (#773)', () => {
  it('lastScheduledBoundary picks this month once the day has passed, else last month', () => {
    expect(lastScheduledBoundary(new Date('2026-11-16T00:00:00Z'), 1).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(lastScheduledBoundary(new Date('2026-11-16T00:00:00Z'), 20).toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(lastScheduledBoundary(new Date('2026-01-05T00:00:00Z'), 10).toISOString()).toBe('2025-12-10T00:00:00.000Z');
  });

  it('isProviderDue: never run, stale, implementation changed', () => {
    const now = new Date('2026-11-16T07:00:00Z');
    const state = {
      provider: 'amenities' as const,
      implementation: 'calgary-open-data',
      lastRunAt: new Date('2026-11-02T07:00:00Z'),
      lastSuccessAt: new Date('2026-11-02T07:00:00Z'),
      lastFailureAt: null,
      firstFailureAt: null,
      consecutiveFailures: 0,
      alertedAt: null,
      lastRowsChanged: 0,
      lastError: null,
    };
    expect(isProviderDue(null, 'calgary-open-data', now, 1)).toBe(true);
    expect(isProviderDue(state, 'calgary-open-data', now, 1)).toBe(false);
    expect(isProviderDue(state, 'paid', now, 1)).toBe(true);
    expect(isProviderDue({ ...state, lastSuccessAt: new Date('2026-10-30T00:00:00Z') }, 'calgary-open-data', now, 1)).toBe(true);
  });
});
