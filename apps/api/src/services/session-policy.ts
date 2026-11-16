/**
 * Session timeout policy (#730, owner decision 2026-11-15).
 *
 * Admin and builder sessions get two limits on top of the `expires_at`
 * stamped at sign-in:
 * - ABSOLUTE: `created_at + absoluteTtlSeconds`. The effective expiry is
 *   the earlier of that and `expires_at`, so lowering the TTL in config
 *   also caps sessions minted under the old (longer) value.
 * - IDLE: a session not used for `idleTimeoutSeconds` stops validating.
 *   Activity is `last_seen_at`, written at most once per
 *   `touchIntervalSeconds` (bounds the write load); rows minted before the
 *   column existed fall back to `created_at`.
 *
 * `withSessionPolicy` decorates a session store so EVERY reader of
 * `findActiveByHash` — guards, AuthContextService, view-as, logout — gets
 * the same answer. There is no second place to forget the check.
 *
 * The pure helpers below hold the arithmetic and are unit-tested directly.
 */

export interface SessionPolicy {
  readonly absoluteTtlSeconds: number;
  readonly idleTimeoutSeconds: number;
  readonly touchIntervalSeconds: number;
}

/** The timestamps every session record carries. */
export interface SessionTimes {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt?: Date | null;
}

/** When the session stops validating, whichever limit comes first. */
export function sessionDeadline(record: SessionTimes, policy: SessionPolicy): Date {
  const lastActivity = record.lastSeenAt ?? record.createdAt;
  return new Date(
    Math.min(
      record.expiresAt.getTime(),
      record.createdAt.getTime() + policy.absoluteTtlSeconds * 1000,
      lastActivity.getTime() + policy.idleTimeoutSeconds * 1000,
    ),
  );
}

/** True while the session is inside both the absolute and the idle limit. */
export function isSessionLive(
  record: SessionTimes,
  now: Date,
  policy: SessionPolicy,
): boolean {
  return sessionDeadline(record, policy).getTime() > now.getTime();
}

/** True when enough time has passed since the last write to record activity again. */
export function shouldTouchSession(
  record: SessionTimes,
  now: Date,
  policy: SessionPolicy,
): boolean {
  const lastActivity = record.lastSeenAt ?? record.createdAt;
  return now.getTime() - lastActivity.getTime() >= policy.touchIntervalSeconds * 1000;
}

/** The store surface the decorator needs (admin + builder stores both fit). */
export interface PolicySessionStore<R extends SessionTimes> {
  findActiveByHash(sessionTokenHash: string, now: Date): Promise<R | null>;
  touch?(sessionTokenHash: string, at: Date): Promise<void>;
}

/**
 * Wrap a session store so `findActiveByHash` enforces the absolute + idle
 * limits and records activity. Every other method passes through.
 *
 * A failed activity write never fails the request: the session was valid,
 * and a missed write can only make the idle timeout fire EARLIER (the
 * previous last_seen_at stays), never later — it fails safe.
 */
export function withSessionPolicy<R extends SessionTimes, S extends PolicySessionStore<R>>(
  store: S,
  policy: SessionPolicy,
): S {
  return {
    ...store,
    async findActiveByHash(sessionTokenHash: string, now: Date): Promise<R | null> {
      const record = await store.findActiveByHash(sessionTokenHash, now);
      if (!record) return null;
      if (!isSessionLive(record, now, policy)) return null;
      if (store.touch && shouldTouchSession(record, now, policy)) {
        try {
          await store.touch(sessionTokenHash, now);
        } catch {
          // Fail safe (see above). No logging: the hash is a credential
          // derivative and the error carries nothing actionable per request.
        }
      }
      return record;
    },
  };
}
