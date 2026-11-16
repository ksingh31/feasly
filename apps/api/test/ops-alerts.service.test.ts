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
  ensureOpsAlertDelivered,
  type OpsAlertType,
} from '../src/services/ops-alerts.service';
import { EmailProviderError } from '../src/services/email';
import type { EmailDelivery } from '../src/services/email/email.service';
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
      return { sent: true as const, provider: 'log' as const };
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
      { type: 'neighbourhood_data_failed', path: '/admin/ops/neighbourhood-data' },
    ];
    for (const { type, path } of cases) {
      await service.notifyFailure(type, FAILURE_CTX);
    }
    expect(sent).toHaveLength(6);
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

/** ACS accepted the message but delivery polling timed out. */
const ACCEPTED_UNCONFIRMED: EmailDelivery = {
  sent: false,
  provider: 'acs',
  failureReason:
    'Azure Communication Services email failed (delivery polling timed out after 7000ms).',
  emailError: 'delivery-failed',
  acceptedByProvider: true,
};

/** Provider never accepted the message. */
const NEVER_ACCEPTED: EmailDelivery = {
  sent: false,
  provider: 'acs',
  failureReason: 'Azure Communication Services email failed (503).',
  emailError: 'delivery-failed',
};

function makeFailingHarness(now: Date, delivery: EmailDelivery) {
  const store = makeStore();
  const warnings: string[] = [];
  const email = {
    sendOpsAlert: vi.fn(async (_input: OpsAlertEmailInput) => delivery),
  };
  const service = createOpsAlertsService({
    email,
    store,
    opsAlertEmail: OPS_EMAIL,
    appBaseUrl: APP_URL,
    dedupeWindowMs: DAY_MS,
    clock: () => now,
    logWarning: (m) => warnings.push(m),
  });
  return { service, store, email, warnings };
}

describe('ops alerts: accepted-but-unconfirmed delivery (#573)', () => {
  const NOW = new Date('2026-10-24T06:00:00Z');

  it('does not throw, records lastFiredAt, and logs a warning', async () => {
    const { service, store, warnings } = makeFailingHarness(
      NOW,
      ACCEPTED_UNCONFIRMED,
    );
    await expect(
      service.notifyFailure('backup_missed', FAILURE_CTX),
    ).resolves.toBeUndefined();
    const state = await store.findByType('backup_missed');
    expect(state?.lastFiredAt?.toISOString()).toBe(NOW.toISOString());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/accepted by provider/);
    expect(warnings[0]).toContain('Postgres backup is failing');
    // No recipient in the log line.
    expect(warnings[0]).not.toContain(OPS_EMAIL);
  });

  it('dedupes a second notifyFailure inside the window: no second email', async () => {
    const { service, email } = makeFailingHarness(NOW, ACCEPTED_UNCONFIRMED);
    await service.notifyFailure('backup_missed', FAILURE_CTX);
    await service.notifyFailure('backup_missed', FAILURE_CTX);
    expect(email.sendOpsAlert).toHaveBeenCalledTimes(1);
  });

  it('still throws and records nothing when the provider never accepted', async () => {
    const { service, store, email, warnings } = makeFailingHarness(
      NOW,
      NEVER_ACCEPTED,
    );
    await expect(
      service.notifyFailure('backup_missed', FAILURE_CTX),
    ).rejects.toBeInstanceOf(EmailProviderError);
    expect(await store.findByType('backup_missed')).toBeNull();
    expect(warnings).toHaveLength(0);
    // Not deduped: the next check retries the send.
    await expect(
      service.notifyFailure('backup_missed', FAILURE_CTX),
    ).rejects.toThrow(/Ops alert email failed/);
    expect(email.sendOpsAlert).toHaveBeenCalledTimes(2);
  });

  it('notifyRecovered treats accepted-but-unconfirmed as sent and re-arms', async () => {
    const { service, store, warnings } = makeFailingHarness(
      NOW,
      ACCEPTED_UNCONFIRMED,
    );
    await store.upsert({ type: 'backup_missed', lastFiredAt: NOW });
    await expect(
      service.notifyRecovered('backup_missed'),
    ).resolves.toBeUndefined();
    const state = await store.findByType('backup_missed');
    expect(state?.lastFiredAt).toBeNull();
    expect(state?.lastRecoveredAt?.toISOString()).toBe(NOW.toISOString());
    expect(warnings).toHaveLength(1);
  });

  it('notifyRecovered still throws and keeps state when never accepted', async () => {
    const { service, store } = makeFailingHarness(NOW, NEVER_ACCEPTED);
    await store.upsert({ type: 'backup_missed', lastFiredAt: NOW });
    await expect(service.notifyRecovered('backup_missed')).rejects.toBeInstanceOf(
      EmailProviderError,
    );
    const state = await store.findByType('backup_missed');
    expect(state?.lastFiredAt?.toISOString()).toBe(NOW.toISOString());
  });
});

describe('ensureOpsAlertDelivered (#573)', () => {
  it('returns silently for a confirmed send', () => {
    const warn = vi.fn();
    ensureOpsAlertDelivered({ sent: true, provider: 'log' }, 'T', warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and returns for accepted-but-unconfirmed', () => {
    const warn = vi.fn();
    expect(() =>
      ensureOpsAlertDelivered(ACCEPTED_UNCONFIRMED, 'T', warn),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable EmailProviderError when never accepted', () => {
    const warn = vi.fn();
    let caught: unknown;
    try {
      ensureOpsAlertDelivered(NEVER_ACCEPTED, 'T', warn);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmailProviderError);
    expect((caught as EmailProviderError).retryable).toBe(false);
    expect((caught as EmailProviderError).failureCode).toBe('delivery-failed');
    expect(warn).not.toHaveBeenCalled();
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
