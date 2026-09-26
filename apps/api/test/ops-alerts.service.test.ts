/**
 * Ops alerting tests (admin/06).
 *
 * Covers: one failure email per alert class per 24h (dedupe, time-mocked),
 * dedupe window expiry re-fires, independent dedupe per class, all-clear
 * exactly once on recovery + window reset, no all-clear when nothing fired,
 * alert bodies contain no PII/secrets, every alert deep-links to its admin
 * view, and recipient comes from config.
 *
 * The store and email are faked at the service boundary; no DB, no network.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import {
  createOpsAlertsService,
  type OpsAlertType,
} from '../src/services/ops-alerts.service';
import type { OpsAlertStore } from '../src/services/ops-alerts.store';
import { createDrizzleOpsAlertStore } from '../src/services/ops-alerts.store';
import type { OpsAlertEmailInput } from '../src/services/email/email.service';
import { createTestDb, type TestDb } from './pglite-db';

const DAY_MS = 86_400_000;
const OPS_EMAIL = 'ops@example.com';
const APP_URL = 'https://app.feasly.example';

function makeStore(): OpsAlertStore & {
  state: Map<string, { lastFiredAt: Date | null; lastRecoveredAt: Date | null }>;
} {
  const state = new Map<
    string,
    { lastFiredAt: Date | null; lastRecoveredAt: Date | null }
  >();
  return {
    state,
    async findByType(type: string) {
      const row = state.get(type);
      return row ? { type, ...row } : null;
    },
    async upsert(args) {
      const prev = state.get(args.type) ?? {
        lastFiredAt: null,
        lastRecoveredAt: null,
      };
      const next = {
        lastFiredAt:
          args.lastFiredAt !== undefined ? args.lastFiredAt : prev.lastFiredAt,
        lastRecoveredAt:
          args.lastRecoveredAt !== undefined
            ? args.lastRecoveredAt
            : prev.lastRecoveredAt,
      };
      state.set(args.type, next);
      return { type: args.type, ...next };
    },
  };
}

function makeHarness(now: Date) {
  const store = makeStore();
  const sent: OpsAlertEmailInput[] = [];
  const email = {
    sendOpsAlert: vi.fn(async (input: OpsAlertEmailInput) => {
      sent.push(input);
      return { provider: 'log' as const };
    }),
  };
  let current = now;
  const service = createOpsAlertsService({
    email,
    store,
    opsAlertEmail: OPS_EMAIL,
    appBaseUrl: APP_URL,
    dedupeWindowMs: DAY_MS,
    clock: () => current,
  });
  return {
    service,
    store,
    sent,
    email,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

const FAILURE_CTX = {
  consecutiveFailures: 3,
  firstFailureAt: new Date('2026-09-25T04:00:00Z'),
};

describe('ops alerts (admin/06)', () => {
  it('fires exactly one failure email per class per 24h', async () => {
    const { service, sent } = makeHarness(new Date('2026-09-25T05:00:00Z'));
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    await service.notifyFailure('sheets_sync_failed', {
      ...FAILURE_CTX,
      consecutiveFailures: 4,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(OPS_EMAIL);
  });

  it('re-fires after the dedupe window expires', async () => {
    const { service, sent, advance } = makeHarness(
      new Date('2026-09-25T05:00:00Z'),
    );
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    advance(DAY_MS + 1_000);
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    expect(sent).toHaveLength(2);
  });

  it('dedupes each alert class independently', async () => {
    const { service, sent } = makeHarness(new Date('2026-09-25T05:00:00Z'));
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    await service.notifyFailure('stripe_webhook_failed', FAILURE_CTX);
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    expect(sent).toHaveLength(2);
  });

  it('sends the all-clear once on recovery and re-arms the class', async () => {
    const { service, sent } = makeHarness(new Date('2026-09-25T05:00:00Z'));
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    await service.notifyRecovered('sheets_sync_failed');
    // Second recovery is a no-op: the all-clear went out exactly once.
    await service.notifyRecovered('sheets_sync_failed');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.title).toMatch(/recovered/i);
    // Re-armed: a new failure streak fires a fresh alert immediately.
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    expect(sent).toHaveLength(3);
  });

  it('does not send an all-clear when no alert was fired', async () => {
    const { service, sent } = makeHarness(new Date('2026-09-25T05:00:00Z'));
    await service.notifyRecovered('sheets_sync_failed');
    expect(sent).toHaveLength(0);
  });

  it('alert bodies contain no PII or secrets and link the admin view', async () => {
    const { service, sent } = makeHarness(new Date('2026-09-25T05:00:00Z'));
    const cases: Array<{ type: OpsAlertType; path: string }> = [
      { type: 'sheets_sync_failed', path: '/admin/ops/sheets' },
      { type: 'community_stats_failed', path: '/admin/ops/community-stats' },
      { type: 'stripe_webhook_failed', path: '/admin/ops/billing' },
      { type: 'narrative_worker_failed', path: '/admin/ops/narrative' },
      { type: 'backup_missed', path: '/admin/ops/backup' },
    ];
    for (const { type, path } of cases) {
      await service.notifyFailure(type, FAILURE_CTX);
    }
    expect(sent).toHaveLength(5);
    for (const [i, { path }] of cases.entries()) {
      const input = sent[i];
      expect(input?.detailsUrl).toBe(`${APP_URL}${path}`);
      const haystack = `${input?.title}\n${input?.summary}\n${input?.detailsUrl}`;
      // No emails, tokens, keys, or connection strings leak into alert copy.
      expect(haystack).not.toMatch(/@/);
      expect(haystack).not.toMatch(/bearer|token|secret|key|password/i);
      // Failure context is present: what failed + since when.
      expect(input?.summary).toContain('3 time(s)');
      expect(input?.summary).toContain(
        FAILURE_CTX.firstFailureAt.toISOString(),
      );
    }
  });

  it('persists dedupe state so a restart does not re-spam', async () => {
    const { service, store } = makeHarness(new Date('2026-09-25T05:00:00Z'));
    await service.notifyFailure('sheets_sync_failed', FAILURE_CTX);
    const persisted = await store.findByType('sheets_sync_failed');
    expect(persisted?.lastFiredAt).toBeInstanceOf(Date);
  });
});

describe('drizzle ops-alert store (migration 0016)', () => {
  let testDb: TestDb;
  let store: OpsAlertStore;

  beforeAll(async () => {
    testDb = await createTestDb();
    store = createDrizzleOpsAlertStore({ db: testDb.db });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('upserts and reads back alert state', async () => {
    expect(await store.findByType('sheets_sync_failed')).toBeNull();
    const firedAt = new Date('2026-09-25T05:00:00Z');
    const written = await store.upsert({
      type: 'sheets_sync_failed',
      lastFiredAt: firedAt,
    });
    expect(written.lastFiredAt?.toISOString()).toBe(firedAt.toISOString());
    expect(written.lastRecoveredAt).toBeNull();

    const recoveredAt = new Date('2026-09-25T06:00:00Z');
    const cleared = await store.upsert({
      type: 'sheets_sync_failed',
      lastFiredAt: null,
      lastRecoveredAt: recoveredAt,
    });
    expect(cleared.lastFiredAt).toBeNull();
    expect(cleared.lastRecoveredAt?.toISOString()).toBe(
      recoveredAt.toISOString(),
    );

    // Partial upsert leaves untouched columns alone.
    const partial = await store.upsert({
      type: 'sheets_sync_failed',
      lastFiredAt: firedAt,
    });
    expect(partial.lastFiredAt?.toISOString()).toBe(firedAt.toISOString());
    expect(partial.lastRecoveredAt?.toISOString()).toBe(
      recoveredAt.toISOString(),
    );
  });
});
