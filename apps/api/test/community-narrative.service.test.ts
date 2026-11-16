/**
 * Monthly community narratives (#759) — the job, admin regenerate, status,
 * and the stored-narrative read, against the real Drizzle store on PGlite
 * (migration 0057 applied).
 *
 * AC1: one row per community per period; a re-run creates none.
 * AC3: a failed month keeps serving last month's narrative; a community
 *      with none gets null (the report then shows the static guide).
 * AC4: admin regenerate works for one community (route test covers audit).
 * AC6: one `community_narrative.run` telemetry event with counts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NARRATIVE_FOOTER, type NarrativePrompt } from '@feasly/cost-engine';
import {
  createCommunityNarrativeService,
  type CommunityNarrativeServiceDeps,
} from '../src/services/community-narrative.service';
import { createDrizzleCommunityNarrativeStore } from '../src/services/community-narrative.store';
import {
  NarrativeProviderError,
  type NarrativeProvider,
} from '../src/services/narrative/narrative.types';
import { loadConfig } from '../src/config';
import { createTestDb, type TestDb } from './pglite-db';

const GOOD = (community: string): string =>
  `${community} is a friendly area with parks and schools nearby. ${NARRATIVE_FOOTER}`;

/** Provider whose output per community is scripted by the test. */
function scriptedProvider(
  script: (community: string, call: number) => string | Error,
): NarrativeProvider & { calls: number } {
  const p = {
    calls: 0,
    synthetic: false,
    async generate(prompt: NarrativePrompt) {
      p.calls++;
      const community = /Project: New home build in (.+), Calgary/.exec(prompt.user)?.[1] ?? '?';
      const out = script(community, p.calls);
      if (out instanceof Error) throw out;
      return { text: out, model: 'test-model' };
    },
  };
  return p;
}

const CONFIG: CommunityNarrativeServiceDeps['config'] = {
  enabled: true,
  runDay: 'last',
  retryDays: 3,
  promptVersion: 'community-v1',
  maxPerRun: 400,
  adminBudgetMs: 60_000,
};

describe('community narrative service (#759)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  beforeEach(async () => {
    await testDb.exec('DELETE FROM community_narratives; DELETE FROM community_stats;');
    await testDb.exec(`
      INSERT INTO community_stats (slug, name, avg_assessed_value, assessment_count, avg_lot_sqft, refreshed_at) VALUES
        ('beltline', 'Beltline', 750000, 1234, 5000, '2026-11-01T00:00:00Z'),
        ('bowness', 'Bowness', 520000, 3000, 6000, '2026-11-01T00:00:00Z'),
        ('cliff-bungalow', 'Cliff Bungalow', 900000, 400, null, '2026-11-01T00:00:00Z');
    `);
  });

  function makeService(
    provider: NarrativeProvider,
    now: Date,
    overrides: Partial<CommunityNarrativeServiceDeps> = {},
  ) {
    const events: Record<string, unknown>[] = [];
    const opsAlerts = { notifyFailure: vi.fn(async () => {}) };
    const service = createCommunityNarrativeService({
      store: createDrizzleCommunityNarrativeStore({ db: testDb.db }),
      provider,
      opsAlerts,
      config: CONFIG,
      clock: () => now,
      logEvent: (e) => events.push(e),
      ...overrides,
    });
    return { service, events, opsAlerts };
  }

  const RUN_DAY = new Date('2026-11-30T09:00:00Z');

  it('AC1: creates exactly one row per community for the period; a re-run creates none', async () => {
    const provider = scriptedProvider((c) => GOOD(c));
    const { service, events } = makeService(provider, RUN_DAY);

    const first = await service.runScheduledTick();
    expect(first).toMatchObject({ period: '2026-12', attempted: 3, succeeded: 3, failed: 0 });
    const rows = await testDb.rows<{ n: number }>(
      `select count(*)::int as n from community_narratives where period = '2026-12' and status = 'succeeded'`,
    );
    expect(rows[0].n).toBe(3);

    const second = await service.runScheduledTick();
    expect(second).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
    const all = await testDb.rows<{ n: number }>(`select count(*)::int as n from community_narratives`);
    expect(all[0].n).toBe(3);
    expect(provider.calls).toBe(3);

    // AC6: telemetry per tick with the counts.
    expect(events[0]).toMatchObject({
      event: 'community_narrative.run',
      trigger: 'timer',
      period: '2026-12',
      succeeded: 3,
      failed: 0,
    });
  });

  it('stores the prompt version and model, with the footer appended', async () => {
    const provider = scriptedProvider((c) => `${c} is lovely.`);
    const { service } = makeService(provider, RUN_DAY);
    await service.runScheduledTick();
    const rows = await testDb.rows<{ narrative: string; model: string; prompt_version: string }>(
      `select narrative, model, prompt_version from community_narratives where community_slug = 'beltline'`,
    );
    expect(rows[0]).toEqual({
      narrative: `Beltline is lovely.\n\n${NARRATIVE_FOOTER}`,
      model: 'test-model',
      prompt_version: 'community-v1',
    });
  });

  it('does nothing outside the run window', async () => {
    const provider = scriptedProvider((c) => GOOD(c));
    const { service, events } = makeService(provider, new Date('2026-11-15T09:00:00Z'));
    const result = await service.runScheduledTick();
    expect(result).toMatchObject({ period: null, attempted: 0 });
    expect(provider.calls).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('is resumable: one failing community does not stop the rest, and is retried next tick', async () => {
    let bownessFails = true;
    const provider = scriptedProvider((c) =>
      c === 'Bowness' && bownessFails ? new NarrativeProviderError('HTTP 503') : GOOD(c),
    );
    const day0 = makeService(provider, RUN_DAY);
    const first = await day0.service.runScheduledTick();
    expect(first).toMatchObject({ attempted: 3, succeeded: 2, failed: 1 });
    const failed = await testDb.rows<{ status: string; last_error: string; attempts: number }>(
      `select status, last_error, attempts from community_narratives where community_slug = 'bowness'`,
    );
    expect(failed[0].status).toBe('failed');
    expect(failed[0].last_error).toContain('503');

    bownessFails = false;
    const day1 = makeService(provider, new Date('2026-12-01T09:00:00Z'));
    const retry = await day1.service.runScheduledTick();
    expect(retry).toMatchObject({ period: '2026-12', attempted: 1, succeeded: 1 });
    expect(day1.opsAlerts.notifyFailure).not.toHaveBeenCalled();
  });

  it('retries once on a validation failure, then records the failure', async () => {
    const provider = scriptedProvider((c) =>
      c === 'Beltline' ? 'Builds here cost $123,456.' : GOOD(c),
    );
    const { service } = makeService(provider, RUN_DAY);
    const result = await service.runScheduledTick();
    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    // 2 calls for Beltline (sample + repair retry) + 1 each for the others.
    expect(provider.calls).toBe(4);
    const row = await testDb.rows<{ last_error: string; narrative: string | null }>(
      `select last_error, narrative from community_narratives where community_slug = 'beltline'`,
    );
    expect(row[0].last_error).toContain('$123,456');
    expect(row[0].narrative).toBeNull();
  });

  it('raises ONE ops alert after the last retry day when failures remain', async () => {
    const provider = scriptedProvider((c) =>
      c === 'Bowness' ? new NarrativeProviderError('HTTP 503') : GOOD(c),
    );
    for (const day of ['2026-11-30', '2026-12-01', '2026-12-02']) {
      const { service, opsAlerts } = makeService(provider, new Date(`${day}T09:00:00Z`));
      const r = await service.runScheduledTick();
      expect(r.alerted).toBe(false);
      expect(opsAlerts.notifyFailure).not.toHaveBeenCalled();
    }
    const last = makeService(provider, new Date('2026-12-03T09:00:00Z'));
    const result = await last.service.runScheduledTick();
    expect(result.alerted).toBe(true);
    expect(last.opsAlerts.notifyFailure).toHaveBeenCalledTimes(1);
    expect(last.opsAlerts.notifyFailure).toHaveBeenCalledWith(
      'narrative_worker_failed',
      expect.objectContaining({ consecutiveFailures: 4 }),
    );
    // The day after the window: no more retries, no more alerts.
    const after = makeService(provider, new Date('2026-12-04T09:00:00Z'));
    const r = await after.service.runScheduledTick();
    expect(r).toMatchObject({ period: null, attempted: 0, alerted: false });
  });

  it('AC3: a failed month keeps serving last month; a new community has none', async () => {
    const ok = scriptedProvider((c) => GOOD(c));
    await makeService(ok, new Date('2026-10-31T09:00:00Z')).service.runScheduledTick();
    const failing = scriptedProvider(() => new NarrativeProviderError('HTTP 503'));
    const { service } = makeService(failing, RUN_DAY);
    await service.runScheduledTick();

    const servable = await service.findServable('beltline');
    expect(servable).toMatchObject({ period: '2026-11', narrative: GOOD('Beltline') });
    expect(await service.findServable('brand-new-place')).toBeNull();
  });

  it('a failed admin regenerate keeps the period text it already had', async () => {
    const ok = scriptedProvider((c) => GOOD(c));
    await makeService(ok, RUN_DAY).service.runScheduledTick();
    const failing = scriptedProvider(() => new NarrativeProviderError('HTTP 503'));
    const { service } = makeService(failing, new Date('2026-12-10T12:00:00Z'));
    const result = await service.regenerate({ communitySlug: 'beltline' });
    expect(result).toMatchObject({ period: '2026-12', failed: 1 });
    expect((await service.findServable('beltline'))?.narrative).toBe(GOOD('Beltline'));
    const status = await service.listStatus();
    expect(status.find((s) => s.communitySlug === 'beltline')).toMatchObject({
      status: 'failed',
      period: '2026-12',
    });
  });

  it('AC4: admin regenerate replaces one community mid-month', async () => {
    const v1 = scriptedProvider((c) => GOOD(c));
    await makeService(v1, RUN_DAY).service.runScheduledTick();
    const v2 = scriptedProvider((c) => `${c} has new City data. ${NARRATIVE_FOOTER}`);
    const now = new Date('2026-12-15T12:00:00Z');
    const { service, events } = makeService(v2, now);
    const result = await service.regenerate({ communitySlug: 'bowness' });
    expect(result).toMatchObject({ trigger: 'admin', period: '2026-12', attempted: 1, succeeded: 1 });
    expect(v2.calls).toBe(1);
    const servable = await service.findServable('bowness');
    expect(servable?.narrative).toContain('new City data');
    expect(servable?.generatedAt.toISOString()).toBe(now.toISOString());
    expect((await service.findServable('beltline'))?.narrative).toBe(GOOD('Beltline'));
    expect(events.at(-1)).toMatchObject({ event: 'community_narrative.run', trigger: 'admin', scope: 'one' });
  });

  it('admin regenerate: 404 for an unknown community, 409 when disabled', async () => {
    const provider = scriptedProvider((c) => GOOD(c));
    const { service } = makeService(provider, RUN_DAY);
    await expect(service.regenerate({ communitySlug: 'nowhere' })).rejects.toMatchObject({ status: 404 });
    const disabled = makeService(provider, RUN_DAY, { config: { ...CONFIG, enabled: false } });
    await expect(disabled.service.regenerate({})).rejects.toMatchObject({ status: 409 });
    expect((await disabled.service.runScheduledTick()).attempted).toBe(0);
  });

  it('admin regenerate-all marks every community stale; the next tick finishes leftovers', async () => {
    const v1 = scriptedProvider((c) => GOOD(c));
    await makeService(v1, RUN_DAY).service.runScheduledTick();
    const v2 = scriptedProvider((c) => `${c} v2. ${NARRATIVE_FOOTER}`);
    const midMonth = new Date('2026-12-15T12:00:00Z');
    // maxPerRun 1 simulates the time budget running out after one.
    const { service } = makeService(v2, midMonth, { config: { ...CONFIG, maxPerRun: 1 } });
    const result = await service.regenerate({});
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, deferred: 2 });
    // Stale rows keep serving their previous text until replaced.
    expect((await service.findServable('cliff-bungalow'))?.narrative).toBe(GOOD('Cliff Bungalow'));

    const nextDay = makeService(v2, new Date('2026-12-16T09:00:00Z'));
    const tick = await nextDay.service.runScheduledTick();
    expect(tick).toMatchObject({ period: null, attempted: 2, succeeded: 2 });
    expect((await service.findServable('cliff-bungalow'))?.narrative).toContain('v2');
    const stale = await testDb.rows<{ n: number }>(
      `select count(*)::int as n from community_narratives where status = 'stale'`,
    );
    expect(stale[0].n).toBe(0);
  });

  it('never stores synthetic (log provider) output', async () => {
    const synthetic: NarrativeProvider = {
      synthetic: true,
      generate: async () => ({ text: 'synthetic narrative placeholder', model: 'log' }),
    };
    const { service, opsAlerts } = makeService(synthetic, new Date('2026-12-03T09:00:00Z'));
    const result = await service.runScheduledTick();
    expect(result.succeeded).toBe(0);
    expect(await service.findServable('beltline')).toBeNull();
    // Dev log mode is not an outage: no ops alert.
    expect(opsAlerts.notifyFailure).not.toHaveBeenCalled();
  });

  it('cost guard: never generates more than maxPerRun per tick', async () => {
    const provider = scriptedProvider((c) => GOOD(c));
    const { service } = makeService(provider, RUN_DAY, { config: { ...CONFIG, maxPerRun: 2 } });
    const result = await service.runScheduledTick();
    expect(result).toMatchObject({ attempted: 2, deferred: 1 });
    expect(provider.calls).toBe(2);
  });

  it('listStatus reports every covered community, including never-generated ones', async () => {
    const provider = scriptedProvider((c) =>
      c === 'Bowness' ? new NarrativeProviderError('HTTP 503') : GOOD(c),
    );
    const { service } = makeService(provider, RUN_DAY, { config: { ...CONFIG, maxPerRun: 2 } });
    await service.runScheduledTick();
    const status = await service.listStatus();
    expect(status.map((s) => [s.communitySlug, s.status])).toEqual([
      ['beltline', 'succeeded'],
      ['bowness', 'failed'],
      ['cliff-bungalow', 'missing'],
    ]);
    expect(status[0].generatedAt?.toISOString()).toBe(RUN_DAY.toISOString());
  });
});

describe('community narrative timer schedule (AC5)', () => {
  it('function.json schedule equals the configured COMMUNITY_NARRATIVE_SCHEDULE default', () => {
    const fn = JSON.parse(
      readFileSync(join(__dirname, '..', 'community-narrative-timer', 'function.json'), 'utf8'),
    ) as { bindings: Array<{ schedule?: string }> };
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(fn.bindings[0].schedule).toBe(config.communityNarratives.schedule);
  });
});
