/**
 * API usage metering + per-key rate limiting (api-mcp/07).
 *
 * Every accepted public API call writes one `api_usage` row. The rate
 * limiter is a sliding window over that table: count rows for the key in
 * the last 60 seconds; deny when the count reaches the key's
 * `rate_limit_per_min`. No Redis at MVP volume — revisit if limiter p99
 * exceeds 50ms under load (story assumption).
 *
 * Rejected 429s write NOTHING (metering counts accepted calls only).
 */
import { randomUUID } from 'node:crypto';
import { ErrorCodes, HttpError } from '../middleware/errors';

/** Sliding window width: 60 seconds (rate limits are per-minute). */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface UsageRecordInput {
  /** The API key that made the call. */
  readonly apiKeyId: string;
  /** Route path, e.g. '/api/v1/estimate'. */
  readonly endpoint: string;
  /** Set when the call created an estimate. */
  readonly estimateId?: string;
}

export interface PerKeyRateLimitVerdict {
  readonly allowed: boolean;
  /** The key's configured limit (requests/minute). */
  readonly limit: number;
  /** Requests remaining in the current window (0 when denied). */
  readonly remaining: number;
  /**
   * Epoch seconds when the window frees capacity — the oldest counted
   * row's timestamp + 60s, or now + 60s when the window is empty.
   */
  readonly resetEpoch: number;
}

export interface UsageAggregate {
  /** Calendar date (UTC) as YYYY-MM-DD. */
  readonly date: string;
  readonly endpoint: string;
  readonly count: number;
  readonly estimatesCreated: number;
}

export interface UsageQuery {
  /** Filter to one key; omitted = all keys (admin only). */
  readonly apiKeyId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

/** Persistence boundary — the Drizzle implementation lives in usage.store.ts. */
export interface UsageStore {
  insert(record: {
    readonly id: string;
    readonly apiKeyId: string;
    readonly endpoint: string;
    readonly estimateId: string | null;
    readonly createdAt: Date;
  }): Promise<void>;
  /**
   * Count rows for the key with created_at > `since`.
   * Used for the sliding-window check.
   */
  countSince(apiKeyId: string, since: Date): Promise<number>;
  /**
   * Oldest created_at for the key with created_at > `since`.
   * Null when the window is empty.
   */
  oldestSince(apiKeyId: string, since: Date): Promise<Date | null>;
  aggregate(query: UsageQuery): Promise<UsageAggregate[]>;
}

export interface UsageServiceDeps {
  readonly store: UsageStore;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

export interface UsageService {
  /**
   * Record one accepted API call. Call AFTER the handler succeeds —
   * never for rejected (429) requests.
   */
  recordUsage(input: UsageRecordInput): Promise<void>;
  /**
   * Sliding-window check for the key. Pure read — writes nothing.
   * The caller records usage separately after the request succeeds.
   */
  checkRateLimit(
    apiKeyId: string,
    limitPerMin: number,
  ): Promise<PerKeyRateLimitVerdict>;
  /**
   * Per-day usage aggregates for billing/metering.
   * `scope` enforces tenant isolation: 'admin' sees all keys,
   * 'owner' is restricted to its own keyId.
   */
  getUsage(
    query: UsageQuery,
    scope: { readonly kind: 'admin' } | { readonly kind: 'owner'; readonly apiKeyId: string },
  ): Promise<UsageAggregate[]>;
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const { store, clock = () => new Date(), newId = () => randomUUID() } = deps;

  return {
    async recordUsage(input: UsageRecordInput): Promise<void> {
      await store.insert({
        id: newId(),
        apiKeyId: input.apiKeyId,
        endpoint: input.endpoint,
        estimateId: input.estimateId ?? null,
        createdAt: clock(),
      });
    },

    async checkRateLimit(
      apiKeyId: string,
      limitPerMin: number,
    ): Promise<PerKeyRateLimitVerdict> {
      const now = clock();
      const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
      const count = await store.countSince(apiKeyId, windowStart);
      const allowed = count < limitPerMin;

      let resetEpoch: number;
      if (allowed) {
        // Window has capacity: reset is a full window from now for the
        // next request that would fill it. Simpler and monotonic.
        resetEpoch = Math.floor(now.getTime() / 1000) + 60;
      } else {
        // Denied: reset when the oldest counted row slides out.
        const oldest = await store.oldestSince(apiKeyId, windowStart);
        resetEpoch = oldest
          ? Math.floor(oldest.getTime() / 1000) + 60
          : Math.floor(now.getTime() / 1000) + 60;
      }

      return {
        allowed,
        limit: limitPerMin,
        remaining: Math.max(0, limitPerMin - count - (allowed ? 1 : 0)),
        resetEpoch,
      };
    },

    async getUsage(
      query: UsageQuery,
      scope:
        | { readonly kind: 'admin' }
        | { readonly kind: 'owner'; readonly apiKeyId: string },
    ): Promise<UsageAggregate[]> {
      if (scope.kind === 'owner') {
        // Key owners see only their own key — ignore any key_id param.
        if (query.apiKeyId && query.apiKeyId !== scope.apiKeyId) {
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'Cannot query usage for another API key.',
            false,
          );
        }
        return store.aggregate({ ...query, apiKeyId: scope.apiKeyId });
      }
      return store.aggregate(query);
    },
  };
}
