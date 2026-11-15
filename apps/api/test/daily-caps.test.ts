/**
 * Global daily circuit breakers (#750).
 *
 * - DailyCap: counts per UTC day, refuses past the limit, fires its
 *   threshold hook exactly once, rolls over at midnight UTC, holds across
 *   two instances.
 * - Email service: over the cap, non-exempt mail is queued (never sent),
 *   exempt mail (ops alerts, billing) still goes; counter outage fails
 *   closed to the queue.
 * - Outbox drain: sends oldest-first within the remaining budget, drops
 *   aged rows, keeps transient failures, removes invalid recipients.
 * - PGlite integration: the real outbox store + real counter store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDailyCap, type DailyCap } from '../src/services/daily-cap.service';
import {
  createEmailService,
  type EmailDelivery,
  type EmailOutboxQueue,
} from '../src/services/email/email.service';
import type { EmailMessage, EmailProvider } from '../src/services/email/email.types';
import { createEmailOutboxService } from '../src/services/email-outbox.service';
import {
  createDrizzleEmailOutboxStore,
  type EmailOutboxRow,
  type EmailOutboxStore,
} from '../src/services/email-outbox.store';
import { createDrizzleRateLimitStore } from '../src/services/rate-limit.store';
import { runEmailOutboxTimer } from '../src/functions/email-outbox-timer';
import { createFakeSharedCounterStore } from './fake-shared-counter-store';
import { createTestDb, type TestDb } from './pglite-db';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY0 = new Date('2026-11-15T09:00:00Z');

describe('createDailyCap', () => {
  it('allows up to the limit, refuses past it, and alerts once at the threshold', async () => {
    const store = createFakeSharedCounterStore();
    const onThreshold = vi.fn();
    const cap = createDailyCap({
      store,
      scope: 'llm',
      limit: 3,
      onThreshold,
      clock: () => DAY0,
    });
    const verdicts = [];
    for (let i = 0; i < 6; i++) verdicts.push((await cap.take()).allowed);
    expect(verdicts).toEqual([true, true, true, false, false, false]);
    // Default threshold = first refused unit, fired exactly once.
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(onThreshold).toHaveBeenCalledWith(4);
    expect(await cap.remaining()).toBe(0);
  });

  it('fires a custom alertAt (80%) once and never blocks on a failing hook', async () => {
    const store = createFakeSharedCounterStore();
    const onThreshold = vi.fn(async () => {
      throw new Error('mail down');
    });
    const cap = createDailyCap({
      store,
      scope: 'email',
      limit: 10,
      alertAt: 8,
      onThreshold,
      clock: () => DAY0,
    });
    for (let i = 0; i < 10; i++) expect((await cap.take()).allowed).toBe(true);
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(onThreshold).toHaveBeenCalledWith(8);
  });

  it('rolls over at midnight UTC', async () => {
    const store = createFakeSharedCounterStore();
    let now = DAY0;
    const cap = createDailyCap({ store, scope: 'llm', limit: 1, clock: () => now });
    expect((await cap.take()).allowed).toBe(true);
    expect((await cap.take()).allowed).toBe(false);
    now = new Date(Math.floor(DAY0.getTime() / DAY_MS) * DAY_MS + DAY_MS);
    expect(await cap.remaining()).toBe(1);
    expect((await cap.take()).allowed).toBe(true);
  });

  it('holds across two instances sharing the store', async () => {
    const store = createFakeSharedCounterStore();
    const make = () => createDailyCap({ store, scope: 'llm', limit: 5, clock: () => DAY0 });
    const a = make();
    const b = make();
    let allowed = 0;
    for (let i = 0; i < 6; i++) {
      if ((await a.take()).allowed) allowed++;
      if ((await b.take()).allowed) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it('propagates store failures (callers fail closed)', async () => {
    const store = createFakeSharedCounterStore();
    store.failing = true;
    const cap = createDailyCap({ store, scope: 'llm', limit: 5, clock: () => DAY0 });
    await expect(cap.take()).rejects.toThrow('store down');
  });
});

function makeProvider(): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: 'log',
    sent,
    async send(message: EmailMessage) {
      sent.push(message);
      return { provider: 'log' as const, messageId: `m-${sent.length}` };
    },
  };
}

function makeQueue(): EmailOutboxQueue & { queued: EmailMessage[]; failing: boolean } {
  const q = {
    queued: [] as EmailMessage[],
    failing: false,
    async enqueue(message: EmailMessage) {
      if (q.failing) throw new Error('db down');
      q.queued.push(message);
    },
  };
  return q;
}

function makeEmail<Q extends EmailOutboxQueue = ReturnType<typeof makeQueue>>(
  cap: DailyCap,
  provider = makeProvider(),
  queue: Q = makeQueue() as unknown as Q,
) {
  const email = createEmailService({
    provider,
    fromAddress: 'noreply@feasly.example',
    fromName: 'Feasly',
    appBaseUrl: 'https://feasly.example',
    unsubscribeBaseUrl: 'https://feasly.example/unsubscribe',
    opsInbox: 'ops@feasly.example',
    retryBackoffMs: 0,
    dailyCap: { cap, outbox: queue },
  });
  return { email, provider, queue };
}

const magicLink = (to: string) => ({
  to,
  magicLinkUrl: 'https://feasly.example/r/token',
  expiresInDays: 7,
  audience: 'consumer' as const,
});

const opsAlert = {
  to: 'ops@feasly.example',
  title: 'Test alert',
  summary: 'Counts only.',
  firedAt: DAY0,
};

describe('email daily cap', () => {
  it('sends under the cap and queues past it (queued + acceptedByProvider)', async () => {
    const store = createFakeSharedCounterStore();
    const cap = createDailyCap({ store, scope: 'email', limit: 2, clock: () => DAY0 });
    const { email, provider, queue } = makeEmail(cap);
    expect((await email.sendMagicLink(magicLink('a@example.com'))).sent).toBe(true);
    expect((await email.sendMagicLink(magicLink('b@example.com'))).sent).toBe(true);
    const third: EmailDelivery = await email.sendMagicLink(magicLink('c@example.com'));
    expect(third.sent).toBe(false);
    if (third.sent) throw new Error('unreachable');
    expect(third.queued).toBe(true);
    expect(third.acceptedByProvider).toBe(true);
    expect(provider.sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);
    expect(queue.queued.map((m) => m.to)).toEqual(['c@example.com']);
  });

  it('never queues ops alerts or billing notices past the cap', async () => {
    const store = createFakeSharedCounterStore();
    const cap = createDailyCap({ store, scope: 'email', limit: 0, clock: () => DAY0 });
    const { email, provider, queue } = makeEmail(cap);
    expect((await email.sendOpsAlert(opsAlert)).sent).toBe(true);
    const billing = await email.sendCommissionPaymentFailed({
      to: 'builder@example.com',
      invoiceRef: 'INV-1',
      commissionCents: 1000,
      currency: 'CAD',
      updateWithinDays: 7,
    });
    expect(billing.sent).toBe(true);
    expect(provider.sent).toHaveLength(2);
    expect(queue.queued).toHaveLength(0);
  });

  it('fails closed to the queue when the counter store is down; exempt mail still sends', async () => {
    const store = createFakeSharedCounterStore();
    store.failing = true;
    const cap = createDailyCap({ store, scope: 'email', limit: 100, clock: () => DAY0 });
    const { email, provider, queue } = makeEmail(cap);
    const delivery = await email.sendMagicLink(magicLink('a@example.com'));
    expect(delivery.sent).toBe(false);
    expect(queue.queued).toHaveLength(1);
    expect((await email.sendOpsAlert(opsAlert)).sent).toBe(true);
    expect(provider.sent.map((m) => m.to)).toEqual(['ops@feasly.example']);
  });

  it('reports a plain failure (no accepted flag) when queueing also fails', async () => {
    const store = createFakeSharedCounterStore();
    const cap = createDailyCap({ store, scope: 'email', limit: 0, clock: () => DAY0 });
    const queue = makeQueue();
    queue.failing = true;
    const { email } = makeEmail(cap, makeProvider(), queue);
    const delivery = await email.sendMagicLink(magicLink('a@example.com'));
    expect(delivery.sent).toBe(false);
    if (delivery.sent) throw new Error('unreachable');
    expect(delivery.acceptedByProvider).toBeUndefined();
    expect(delivery.queued).toBeUndefined();
  });
});

function makeOutboxStore(): EmailOutboxStore & { rows: Map<string, EmailOutboxRow & { lastError?: string }> } {
  const rows = new Map<string, EmailOutboxRow & { lastError?: string }>();
  let n = 0;
  return {
    rows,
    async enqueue(message, now) {
      n += 1;
      rows.set(`r${n}`, { id: `r${n}`, message, attempts: 0, createdAt: now });
    },
    async listPending(limit) {
      return [...rows.values()]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit);
    },
    async remove(id) {
      rows.delete(id);
    },
    async recordFailure(id, reason) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, attempts: row.attempts + 1, lastError: reason });
    },
    async deleteOlderThan(cutoff) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.createdAt < cutoff) {
          rows.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}

const msg = (to: string): EmailMessage => ({ to, subject: 's', html: '<p>h</p>', text: 't' });

describe('email outbox drain', () => {
  it('sends oldest-first within the remaining budget and stops at the cap', async () => {
    const store = createFakeSharedCounterStore();
    const cap = createDailyCap({ store, scope: 'email', limit: 2, clock: () => DAY0 });
    const outbox = makeOutboxStore();
    await outbox.enqueue(msg('old@example.com'), new Date(DAY0.getTime() - 3_000));
    await outbox.enqueue(msg('mid@example.com'), new Date(DAY0.getTime() - 2_000));
    await outbox.enqueue(msg('new@example.com'), new Date(DAY0.getTime() - 1_000));
    const sent: string[] = [];
    const drain = createEmailOutboxService({
      store: outbox,
      cap,
      send: async (m) => {
        sent.push(m.to);
        return { sent: true, provider: 'log' };
      },
      maxAgeMs: DAY_MS,
      clock: () => DAY0,
    });
    const result = await drain.drain();
    expect(sent).toEqual(['old@example.com', 'mid@example.com']);
    expect(result).toEqual({ sent: 2, failed: 0, retrying: 0, expired: 0 });
    expect([...outbox.rows.values()].map((r) => r.message.to)).toEqual(['new@example.com']);
    // Budget exhausted: a second run sends nothing today.
    expect((await drain.drain()).sent).toBe(0);
  });

  it('drops aged rows, removes invalid recipients, keeps transient failures', async () => {
    const store = createFakeSharedCounterStore();
    const cap = createDailyCap({ store, scope: 'email', limit: 10, clock: () => DAY0 });
    const outbox = makeOutboxStore();
    await outbox.enqueue(msg('stale@example.com'), new Date(DAY0.getTime() - 2 * DAY_MS));
    await outbox.enqueue(msg('bad@example.com'), new Date(DAY0.getTime() - 2_000));
    await outbox.enqueue(msg('flaky@example.com'), new Date(DAY0.getTime() - 1_000));
    const drain = createEmailOutboxService({
      store: outbox,
      cap,
      send: async (m): Promise<EmailDelivery> =>
        m.to === 'bad@example.com'
          ? { sent: false, provider: 'log', failureReason: 'rejected', emailError: 'invalid-recipient' }
          : { sent: false, provider: 'log', failureReason: 'timeout', emailError: 'delivery-failed' },
      maxAgeMs: DAY_MS,
      clock: () => DAY0,
    });
    expect(await drain.drain()).toEqual({ sent: 0, failed: 1, retrying: 1, expired: 1 });
    const left = [...outbox.rows.values()];
    expect(left.map((r) => r.message.to)).toEqual(['flaky@example.com']);
    expect(left[0]?.attempts).toBe(1);
  });

  it('a queued email is delivered by the timer after midnight UTC', async () => {
    const counters = createFakeSharedCounterStore();
    let now = DAY0;
    const cap = createDailyCap({ store: counters, scope: 'email', limit: 1, clock: () => now });
    const outbox = makeOutboxStore();
    const provider = makeProvider();
    const { email } = makeEmail(cap, provider, outbox);
    await email.sendMagicLink(magicLink('first@example.com'));
    const queued = await email.sendMagicLink(magicLink('second@example.com'));
    expect(queued.sent).toBe(false);
    expect(outbox.rows.size).toBe(1);
    const drain = createEmailOutboxService({
      store: outbox,
      cap,
      send: async (m) => {
        await provider.send(m);
        return { sent: true, provider: 'log' };
      },
      maxAgeMs: DAY_MS,
      clock: () => now,
    });
    const logs: string[] = [];
    const context = { log: (...args: unknown[]) => logs.push(args.join(' ')) };
    await runEmailOutboxTimer({ emailOutboxService: drain }, context);
    expect(outbox.rows.size).toBe(1); // still today: no budget
    now = new Date(Math.floor(DAY0.getTime() / DAY_MS) * DAY_MS + DAY_MS + 60_000);
    await runEmailOutboxTimer({ emailOutboxService: drain }, context);
    expect(outbox.rows.size).toBe(0);
    expect(provider.sent.map((m) => m.to)).toEqual(['first@example.com', 'second@example.com']);
    // Counts only in logs — never the recipient.
    expect(logs.join('\n')).toContain('sent=1');
    expect(logs.join('\n')).not.toContain('@example.com');
  });

  it('timer logs CYCLE FAILED and rethrows on a store error', async () => {
    const logs: string[] = [];
    const failing = { drain: async () => Promise.reject(new Error('db down')) };
    await expect(
      runEmailOutboxTimer({ emailOutboxService: failing }, { log: (m: unknown) => logs.push(String(m)) }),
    ).rejects.toThrow('db down');
    expect(logs[0]).toContain('email-outbox-timer: CYCLE FAILED');
  });
});

describe('email outbox + daily cap (PGlite integration)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('queues past the cap in Postgres and drains the next day, deleting sent rows', async () => {
    const counters = createDrizzleRateLimitStore({ db: testDb.db });
    const outbox = createDrizzleEmailOutboxStore({ db: testDb.db });
    let now = DAY0;
    const cap = createDailyCap({ store: counters, scope: 'email', limit: 1, clock: () => now });
    const provider = makeProvider();
    const { email } = makeEmail(cap, provider, outbox);
    await email.sendMagicLink(magicLink('first@example.com'));
    await email.sendNudge({
      to: 'second@example.com',
      resumeUrl: 'https://feasly.example/r/x',
      unsubscribeUrl: 'https://feasly.example/unsubscribe/t',
    });
    const pending = await outbox.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message.to).toBe('second@example.com');
    expect(pending[0]?.message.headers?.['List-Unsubscribe']).toBe(
      '<https://feasly.example/unsubscribe/t>',
    );
    now = new Date(Math.floor(DAY0.getTime() / DAY_MS) * DAY_MS + DAY_MS + 60_000);
    const drain = createEmailOutboxService({
      store: outbox,
      cap,
      send: async (m) => {
        await provider.send(m);
        return { sent: true, provider: 'log' };
      },
      maxAgeMs: 2 * DAY_MS,
      clock: () => now,
    });
    expect((await drain.drain()).sent).toBe(1);
    expect(await outbox.listPending(10)).toHaveLength(0);
    expect(provider.sent.map((m) => m.to)).toEqual(['first@example.com', 'second@example.com']);
  });

  it('records transient failures and purges aged rows', async () => {
    const outbox = createDrizzleEmailOutboxStore({ db: testDb.db });
    await outbox.enqueue(msg('a@example.com'), new Date(DAY0.getTime() - 3 * DAY_MS));
    await outbox.enqueue(msg('b@example.com'), DAY0);
    const rows = await outbox.listPending(10);
    const b = rows.find((r) => r.message.to === 'b@example.com');
    if (!b) throw new Error('missing row');
    await outbox.recordFailure(b.id, 'timeout');
    expect(await outbox.deleteOlderThan(new Date(DAY0.getTime() - DAY_MS))).toBe(1);
    const left = await outbox.listPending(10);
    expect(left.map((r) => [r.message.to, r.attempts])).toEqual([['b@example.com', 1]]);
  });
});

