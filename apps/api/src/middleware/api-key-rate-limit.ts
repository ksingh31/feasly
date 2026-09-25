/**
 * Per-key rate limiting middleware (api-mcp/07).
 *
 * Wraps a request handler: when the request carries a Bearer API key,
 * authenticate it, enforce its per-key sliding-window limit (backed by
 * the `api_usage` table), and record usage on success.
 *
 * Requests WITHOUT a Bearer key pass through untouched — the web app and
 * other first-party clients don't use API keys, and the pipeline's
 * IP-based limiting still applies to them. This keeps the change additive
 * and non-breaking.
 *
 * 429s carry code=RATE_LIMITED plus X-RateLimit-Limit / -Remaining /
 * -Reset headers. Rejected requests write no usage rows.
 */
import {
  authenticateApiKey,
  type ApiKeyAuthContext,
} from './api-key-auth';
import { rateLimitedProblem, type ProblemDetails } from './errors';
import type { ApiKeyService } from '../services/api-key.service';
import type { UsageService } from '../services/usage.service';

export interface ApiKeyRateLimitDeps {
  readonly apiKeys: ApiKeyService;
  readonly usage: UsageService;
  /**
   * Log sink for rate-limit denials. Defaults to console.warn; the
   * Functions adapters inject the context logger.
   */
  readonly logger?: (message: string, correlationId: string) => void;
}

export interface ApiKeyRateLimitOptions {
  /** Route path for usage metering, e.g. '/api/v1/estimate'. */
  readonly endpoint: string;
  /**
   * Extract an estimate ID from a successful response for the
   * estimates_created aggregate. Omitted for non-estimate endpoints.
   */
  readonly extractEstimateId?: (result: unknown) => string | undefined;
}

/**
 * Run the handler with per-key rate limiting when a Bearer key is present.
 *
 * Returns the handler's result, or a 429 ProblemDetails for over-limit
 * keys. (401s from bad keys are thrown by authenticateApiKey — the
 * caller's pipeline converts them to ProblemDetails.)
 *
 * Usage is recorded AFTER the handler runs — never for 429s. A handler
 * that returns a ProblemDetails (e.g. validation error) still consumed
 * the key's budget, so it IS metered; only transport-level 429 rejections
 * skip the write.
 */
export function createApiKeyRateLimitMiddleware(deps: ApiKeyRateLimitDeps) {
  const { apiKeys, usage, logger = (msg) => console.warn(msg) } = deps;

  return async function withApiKeyRateLimit<T>(
    headers: Record<string, string | string[] | undefined>,
    correlationId: string,
    options: ApiKeyRateLimitOptions,
    handler: (auth: ApiKeyAuthContext | null) => Promise<T>,
  ): Promise<T | ProblemDetails> {
    const raw = headers['authorization'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const hasBearer =
      typeof value === 'string' && /^Bearer /i.test(value.trim());

    if (!hasBearer) {
      // No API key — first-party traffic, existing pipeline limiting applies.
      return handler(null);
    }

    // Authenticate: throws 401 INVALID_API_KEY on any failure (no oracle).
    const auth = await authenticateApiKey(headers, apiKeys);

    // Sliding-window check against the usage table.
    const verdict = await usage.checkRateLimit(auth.keyId, auth.rateLimitPerMin);

    if (!verdict.allowed) {
      logger(
        `per-key rate-limited keyId=${auth.keyId} endpoint=${options.endpoint}`,
        correlationId,
      );
      const retryAfterMs = Math.max(0, verdict.resetEpoch * 1000 - Date.now());
      return rateLimitedProblem(correlationId, retryAfterMs, {
        limit: verdict.limit,
        remaining: verdict.remaining,
        resetEpoch: verdict.resetEpoch,
      });
    }

    const result = await handler(auth);

    const estimateId = options.extractEstimateId
      ? options.extractEstimateId(result)
      : undefined;
    await usage.recordUsage({
      apiKeyId: auth.keyId,
      endpoint: options.endpoint,
      estimateId,
    });

    return result;
  };
}
