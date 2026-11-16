/**
 * Postgres-backed job queue (#838, AC1 + AC2).
 *
 * The queue runs against PGlite with the real migrations applied (pins
 * migration 0064) and a FIXED, manually advanced clock — no sleeps. Covers:
 * processing, retry with exponential backoff, dead-letter after max
 * attempts, permanent failures, missing handlers, idempotent enqueue,
 * stale-lock reclaim, SKIP LOCKED claiming, cancel-on-unsubscribe, lead
 * erasure cascade, and the admin failed-jobs view.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { estimates, jobs, leads } from '../src/db/schema';
import { createDrizzleJobQueueStore, type JobQueueStore, type JobRecord } from '../src/services/job-queue.store';
import {
  backoffSeconds,
  createJobQueueService,
  PermanentJobError,
  type JobHandler,
} from '../src/services/job-queue.service';
import { createTestDb, type TestDb } from './pglite-db';

const T0 = new Date('2026-11-16T12:00:00.000Z');
const SEC = 1000;

async function seedLead(testDb: TestDb, id: string): Promise<void> {
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: 'calgary-123-fake-st-nw',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  await testDb.db.insert(leads).values({
    id,
    estimateId,
    addressKey: 'calgary-123-fake-st-nw',
    email: 'ava.homeowner@example.com',
    name: 'Ava Homeowner',
    timeline: '6-12 months',
    consentTs: T0,
  });
}

describe('backoffSeconds', () => {
  it('doubles from the base per failed attempt and caps at the max', () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffSeconds(n, 300, 3600))).toEqual([
      300, 600, 1200, 2400, 3600,
    ]);
    expect(backoffSeconds(1_000, 300, 3600)).toBe(3600);
  });
});

describe('job queue (PGlite, fixed clock)', () => {
  let testDb: TestDb;
  let store: JobQueueStore;
  let now: Date;
  const clock = (): Date => now;
  const advance = (ms: number): void => {
    now = new Date(now.getTime() + ms);
  };
  let handlers: Record<string, JobHandler>;
  let errors: string[];

  function queue(overrides?: { maxAttempts?: number; batchSize?: number }) {
    return createJobQueueService({
      store,
      handlers: () => handlers,
      batchSize: overrides?.batchSize ?? 10,
      maxAttempts: overrides?.maxAttempts ?? 3,
      backoffBaseSeconds: 60,
      backoffMaxSeconds: 3600,
      lockTimeoutSeconds: 600,
      onJobError: (m) => errors.push(m),
      clock,
    });
  }

  async function jobById(id: string): Promise<JobRecord> {
    const rows = await store.listByStatus({ status: 'pending', limit: 100 });
    const all = [
      ...rows,
      ...(await store.listByStatus({ status: 'running', limit: 100 })),
      ...(await store.listByStatus({ status: 'done', limit: 100 })),
      ...(await store.listByStatus({ status: 'dead', limit: 100 })),
      ...(await store.listByStatus({ status: 'cancelled', limit: 100 })),
    ];
    const found = all.find((j) => j.id === id);
    if (!found) throw new Error(`job ${id} not found`);
    return found;
  }

  async function onlyJob(): Promise<JobRecord> {
    const rows = await testDb.rows<{ id: string }>('SELECT id FROM jobs');
    expect(rows).toHaveLength(1);
    return jobById(rows[0]!.id);
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    store = createDrizzleJobQueueStore({ db: testDb.db });
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    await testDb.db.delete(jobs);
    now = T0;
    handlers = {};
    errors = [];
  });

  it('pins migration 0064: jobs table, indexes, and partner_shares.kind', async () => {
    const indexes = await testDb.rows<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'jobs'",
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(['jobs_dedupe_key_idx', 'jobs_status_run_at_idx', 'jobs_lead_id_idx']),
    );
    const cols = await testDb.rows<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'partner_shares'",
    );
    expect(cols.find((c) => c.column_name === 'kind')?.is_nullable).toBe('NO');
    expect(cols.find((c) => c.column_name === 'partner_email')?.is_nullable).toBe('YES');
  });

  it('processes a due job and marks it done', async () => {
    const seen: string[] = [];
    handlers = { 'test.ok': async (job) => void seen.push(String(job.payload['n'])) };
    const q = queue();
    await q.enqueue({ type: 'test.ok', payload: { n: 7 } });

    expect(await q.runOnce()).toEqual({ claimed: 1, done: 1, retried: 0, deadLettered: 0 });
    expect(seen).toEqual(['7']);
    const job = await onlyJob();
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(1);
    expect(job.completedAt).toEqual(T0);
  });

  it('does not run a job before its run_at', async () => {
    handlers = { 'test.ok': async () => {} };
    const q = queue();
    await q.enqueue({ type: 'test.ok', runAt: new Date(T0.getTime() + 3600 * SEC) });
    expect((await q.runOnce()).claimed).toBe(0);
    advance(3600 * SEC);
    expect((await q.runOnce()).done).toBe(1);
  });

  it('enqueue is idempotent on the dedupe key', async () => {
    const q = queue();
    expect(await q.enqueue({ type: 'test.ok', dedupeKey: 'k1' })).toEqual({ enqueued: true });
    expect(await q.enqueue({ type: 'test.ok', dedupeKey: 'k1' })).toEqual({ enqueued: false });
    const rows = await testDb.rows('SELECT id FROM jobs');
    expect(rows).toHaveLength(1);
  });

  it('AC1: retries with exponential backoff, then dead-letters after max attempts', async () => {
    let calls = 0;
    handlers = {
      'test.flaky': async () => {
        calls++;
        throw new Error('provider down for sam@example.com');
      },
    };
    const q = queue({ maxAttempts: 3 });
    await q.enqueue({ type: 'test.flaky' });

    // Attempt 1 fails → retry in 60s.
    expect(await q.runOnce()).toEqual({ claimed: 1, done: 0, retried: 1, deadLettered: 0 });
    let job = await onlyJob();
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.runAt).toEqual(new Date(T0.getTime() + 60 * SEC));
    // The stored error is sanitized — no email address.
    expect(job.lastError).toContain('provider down');
    expect(job.lastError).not.toContain('sam@example.com');

    // Not due yet: nothing claimed.
    advance(59 * SEC);
    expect((await q.runOnce()).claimed).toBe(0);

    // Attempt 2 fails → retry in 120s (doubled).
    advance(1 * SEC);
    expect((await q.runOnce()).retried).toBe(1);
    job = await onlyJob();
    expect(job.attempts).toBe(2);
    expect(job.runAt).toEqual(new Date(now.getTime() + 120 * SEC));

    // Attempt 3 (the last) fails → dead-lettered, never retried again.
    advance(120 * SEC);
    expect(await q.runOnce()).toEqual({ claimed: 1, done: 0, retried: 0, deadLettered: 1 });
    job = await onlyJob();
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(3);
    expect(calls).toBe(3);

    advance(24 * 3600 * SEC);
    expect((await q.runOnce()).claimed).toBe(0);
    expect(calls).toBe(3);
    expect(errors.some((e) => e.includes('dead-lettered'))).toBe(true);
    expect(errors.join('\n')).not.toContain('sam@example.com');
  });

  it('a job that fails then succeeds ends done', async () => {
    let calls = 0;
    handlers = {
      'test.once': async () => {
        calls++;
        if (calls === 1) throw new Error('blip');
      },
    };
    const q = queue();
    await q.enqueue({ type: 'test.once' });
    await q.runOnce();
    advance(60 * SEC);
    expect((await q.runOnce()).done).toBe(1);
    expect((await onlyJob()).status).toBe('done');
  });

  it('a PermanentJobError dead-letters on the first attempt', async () => {
    handlers = {
      'test.bad': async () => {
        throw new PermanentJobError('payload invalid');
      },
    };
    const q = queue({ maxAttempts: 5 });
    await q.enqueue({ type: 'test.bad' });
    expect((await q.runOnce()).deadLettered).toBe(1);
    expect((await onlyJob()).status).toBe('dead');
  });

  it('a job type with no handler is dead-lettered', async () => {
    const q = queue();
    await q.enqueue({ type: 'test.unknown' });
    expect((await q.runOnce()).deadLettered).toBe(1);
    const job = await onlyJob();
    expect(job.status).toBe('dead');
    expect(job.lastError).toContain('no handler');
  });

  it('a running job whose worker died is reclaimed after the lock timeout', async () => {
    const q = queue();
    await q.enqueue({ type: 'test.ok' });
    // A worker claims the job and crashes (never completes it).
    const claimed = await store.claimDue({ now, staleBefore: new Date(0), limit: 10 });
    expect(claimed).toHaveLength(1);
    handlers = { 'test.ok': async () => {} };

    advance(599 * SEC);
    expect((await q.runOnce()).claimed).toBe(0);
    advance(2 * SEC);
    expect(await q.runOnce()).toEqual({ claimed: 1, done: 1, retried: 0, deadLettered: 0 });
    // The crashed run counted as an attempt.
    expect((await onlyJob()).attempts).toBe(2);
  });

  it('claims are disjoint: a claimed job is not handed to a second claimer', async () => {
    const q = queue();
    for (let i = 0; i < 5; i++) await q.enqueue({ type: 'test.ok' });
    const [a, b] = await Promise.all([
      store.claimDue({ now, staleBefore: new Date(0), limit: 3 }),
      store.claimDue({ now, staleBefore: new Date(0), limit: 3 }),
    ]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });

  it('respects the batch size', async () => {
    handlers = { 'test.ok': async () => {} };
    const q = queue({ batchSize: 2 });
    for (let i = 0; i < 3; i++) await q.enqueue({ type: 'test.ok' });
    expect((await q.runOnce()).claimed).toBe(2);
    expect((await q.runOnce()).claimed).toBe(1);
  });

  it('AC2: cancelForLead withdraws the lead\'s pending jobs only', async () => {
    const leadA = randomUUID();
    const leadB = randomUUID();
    await seedLead(testDb, leadA);
    await seedLead(testDb, leadB);
    const sent: string[] = [];
    handlers = { 'reminder.x': async (job) => void sent.push(job.leadId ?? '') };
    const q = queue();
    await q.enqueue({ type: 'reminder.x', leadId: leadA, runAt: new Date(T0.getTime() + 3600 * SEC) });
    await q.enqueue({ type: 'reminder.x', leadId: leadB, runAt: new Date(T0.getTime() + 3600 * SEC) });

    expect(await q.cancelForLead(leadA)).toBe(1);
    advance(3600 * SEC);
    await q.runOnce();
    expect(sent).toEqual([leadB]);
    const cancelled = await store.listByStatus({ status: 'cancelled', limit: 10 });
    expect(cancelled.map((j) => j.leadId)).toEqual([leadA]);
  });

  it('erasing a lead removes its jobs (FK cascade)', async () => {
    const lead = randomUUID();
    await seedLead(testDb, lead);
    await queue().enqueue({ type: 'reminder.x', leadId: lead });
    await testDb.exec(`DELETE FROM leads WHERE id = '${lead}'`);
    expect(await testDb.rows('SELECT id FROM jobs')).toHaveLength(0);
  });

  it('admin view lists failed jobs with per-status counts', async () => {
    handlers = {
      'test.ok': async () => {},
      'test.bad': async () => {
        throw new PermanentJobError('nope');
      },
    };
    const q = queue();
    await q.enqueue({ type: 'test.ok' });
    await q.enqueue({ type: 'test.bad' });
    await q.enqueue({ type: 'test.ok', runAt: new Date(T0.getTime() + 3600 * SEC) });
    await q.runOnce();

    const view = await q.listJobs();
    expect(view.status).toBe('dead');
    expect(view.counts).toEqual({ pending: 1, running: 0, done: 1, dead: 1, cancelled: 0 });
    expect(view.jobs).toHaveLength(1);
    expect(view.jobs[0]).toMatchObject({
      type: 'test.bad',
      status: 'dead',
      attempts: 1,
      lastError: 'nope',
      completedAt: T0.toISOString(),
    });
    expect((await q.listJobs({ status: 'pending' })).jobs).toHaveLength(1);
  });
});
