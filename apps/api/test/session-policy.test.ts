/**
 * #730 — session timeout policy: absolute cap + idle timeout + activity
 * tracking, and the store decorator every session reader goes through.
 *
 * AC4: "An idle admin session expires at the configured timeout."
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isSessionLive,
  sessionDeadline,
  shouldTouchSession,
  withSessionPolicy,
  type SessionPolicy,
} from '../src/services/session-policy';
import {
  createAdminAuthService,
  hashSessionToken,
  type AdminSessionRecord,
  type AdminSessionStore,
} from '../src/services/admin-auth.service';

// Owner decision 2026-11-15: admin 12 h absolute / 1 h idle.
const ADMIN_POLICY: SessionPolicy = {
  absoluteTtlSeconds: 43_200,
  idleTimeoutSeconds: 3_600,
  touchIntervalSeconds: 60,
};
const SIGNED_IN = new Date('2026-11-16T08:00:00Z');
const HOUR = 3_600_000;

function at(msAfterSignIn: number): Date {
  return new Date(SIGNED_IN.getTime() + msAfterSignIn);
}

describe('session policy arithmetic (#730)', () => {
  const fresh = {
    createdAt: SIGNED_IN,
    // A 7-day row minted under the old TTL.
    expiresAt: at(7 * 24 * HOUR),
    lastSeenAt: null,
  };

  it('an untouched session dies at the idle timeout (created_at stands in for activity)', () => {
    expect(isSessionLive(fresh, at(HOUR - 1), ADMIN_POLICY)).toBe(true);
    expect(isSessionLive(fresh, at(HOUR), ADMIN_POLICY)).toBe(false);
  });

  it('activity extends the idle window', () => {
    const active = { ...fresh, lastSeenAt: at(5 * HOUR) };
    expect(isSessionLive(active, at(5.9 * HOUR), ADMIN_POLICY)).toBe(true);
    expect(isSessionLive(active, at(6 * HOUR), ADMIN_POLICY)).toBe(false);
  });

  it('the absolute cap wins over activity, and over a longer stored expires_at', () => {
    const busy = { ...fresh, lastSeenAt: at(11.9 * HOUR) };
    expect(sessionDeadline(busy, ADMIN_POLICY)).toEqual(at(12 * HOUR));
    expect(isSessionLive(busy, at(12 * HOUR), ADMIN_POLICY)).toBe(false);
  });

  it('a stored expires_at shorter than the policy still wins', () => {
    const short = { ...fresh, expiresAt: at(30 * 60_000) };
    expect(isSessionLive(short, at(30 * 60_000), ADMIN_POLICY)).toBe(false);
  });

  it('activity is written at most once per touch interval', () => {
    const seen = { ...fresh, lastSeenAt: at(HOUR / 2) };
    expect(shouldTouchSession(seen, at(HOUR / 2 + 59_000), ADMIN_POLICY)).toBe(false);
    expect(shouldTouchSession(seen, at(HOUR / 2 + 60_000), ADMIN_POLICY)).toBe(true);
  });
});

function sessionRow(overrides: Partial<AdminSessionRecord> = {}): AdminSessionRecord {
  return {
    id: 's-1',
    email: 'admin@example.com',
    sessionTokenHash: hashSessionToken('tok'),
    idToken: null,
    revokedAt: null,
    expiresAt: at(7 * 24 * HOUR),
    createdAt: SIGNED_IN,
    lastSeenAt: null,
    userId: 'u-1',
    activeBuilderId: null,
    viewAs: null,
    ...overrides,
  };
}

/** In-memory store mirroring the Drizzle store: findActiveByHash checks expires_at only. */
function memoryStore(row: AdminSessionRecord) {
  let current: AdminSessionRecord = row;
  const touch = vi.fn(async (_hash: string, when: Date) => {
    current = { ...current, lastSeenAt: when };
  });
  const store: AdminSessionStore = {
    insert: vi.fn(),
    findActiveByHash: async (hash, now) =>
      hash === current.sessionTokenHash &&
      !current.revokedAt &&
      current.expiresAt.getTime() > now.getTime()
        ? current
        : null,
    findByHash: async (hash) =>
      hash === current.sessionTokenHash && !current.revokedAt ? current : null,
    touch,
    revokeByHash: vi.fn(),
    revokeByEmail: vi.fn(),
    updateState: vi.fn(),
  };
  return { store, touch, get: () => current };
}

describe('withSessionPolicy store decorator (#730)', () => {
  it('rejects an idle session even though the stored expires_at is days away', async () => {
    const { store } = memoryStore(sessionRow());
    const wrapped = withSessionPolicy(store, ADMIN_POLICY);
    expect(await wrapped.findActiveByHash(hashSessionToken('tok'), at(HOUR))).toBeNull();
  });

  it('keeps a session alive while it is used, and records the activity', async () => {
    const { store, touch, get } = memoryStore(sessionRow());
    const wrapped = withSessionPolicy(store, ADMIN_POLICY);
    const hash = hashSessionToken('tok');
    // Used every 50 minutes for 10 hours: never idle for a full hour.
    for (let minutes = 50; minutes <= 600; minutes += 50) {
      expect(await wrapped.findActiveByHash(hash, at(minutes * 60_000))).not.toBeNull();
    }
    expect(touch).toHaveBeenCalledTimes(12);
    expect(get().lastSeenAt).toEqual(at(600 * 60_000));
    // Then idle for an hour → gone.
    expect(await wrapped.findActiveByHash(hash, at(660 * 60_000))).toBeNull();
  });

  it('does not write activity more than once per touch interval', async () => {
    const { store, touch } = memoryStore(sessionRow({ lastSeenAt: at(10 * 60_000) }));
    const wrapped = withSessionPolicy(store, ADMIN_POLICY);
    await wrapped.findActiveByHash(hashSessionToken('tok'), at(10 * 60_000 + 30_000));
    expect(touch).not.toHaveBeenCalled();
  });

  it('a failed activity write does not fail the (valid) request', async () => {
    const { store } = memoryStore(sessionRow());
    store.touch = vi.fn(async () => {
      throw new Error('db down');
    });
    const wrapped = withSessionPolicy(store, ADMIN_POLICY);
    expect(await wrapped.findActiveByHash(hashSessionToken('tok'), at(60_000))).not.toBeNull();
  });

  it('passes every other method through untouched', () => {
    const { store } = memoryStore(sessionRow());
    const wrapped = withSessionPolicy(store, ADMIN_POLICY);
    expect(wrapped.revokeByHash).toBe(store.revokeByHash);
    expect(wrapped.findByHash).toBe(store.findByHash);
  });

  it('an idle-expired admin session reports "expired" (not "invalid") for the expiry copy', async () => {
    const { store } = memoryStore(sessionRow());
    const service = createAdminAuthService({
      sessions: withSessionPolicy(store, ADMIN_POLICY),
      audit: { log: vi.fn() } as never,
      entraSignIn: { configured: false, logoutEndpoint: '' },
      clock: () => at(2 * HOUR),
    });
    expect(await service.validateSession('tok')).toBeNull();
    expect(await service.isSessionExpired('tok')).toBe(true);
    expect(await service.isSessionExpired('unknown')).toBe(false);
  });
});
