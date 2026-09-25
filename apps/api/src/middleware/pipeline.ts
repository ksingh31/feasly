/**
 * Request pipeline (BE0-003): correlation → rate limit → handler → errors.
 *
 * Framework-agnostic on purpose: BE-3's Azure Functions trigger adapters
 * build the `PipelineRequest` from the Functions request object and hand the
 * pipeline a thin route handler. Public routes run through this pipeline;
 * BE-4 adds authentication in front of it for dashboard/admin routes.
 */
import { createHash } from 'node:crypto';
import { ensureCorrelationId, type HeaderValue } from './correlation';
import {
  rateLimitedProblem,
  toProblemDetails,
  type ProblemDetails,
} from './errors';
import type { RateLimiter } from './rate-limit';

export interface PipelineRequest {
  readonly headers: Record<string, HeaderValue>;
  readonly clientIp: string | undefined;
  /**
   * Present only on builder embeds (the adapter copies it from the request
   * body). Available to custom `keyFor` functions so a future rate-limit
   * policy can aggregate per tenant as well as per IP (see the estimates
   * rate-limit story).
   */
  readonly tenantKey?: string;
}

export interface PipelineContext {
  readonly correlationId: string;
  readonly clientIp: string | undefined;
}

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly correlationId: string;
}

export interface RequestPipeline {
  /**
   * Run one request. Resolves to the handler's result, or to a
   * ProblemDetails when rate-limited or when the handler throws.
   * Narrow with `isProblemDetails` from `./errors`.
   */
  run<T>(
    request: PipelineRequest,
    handler: (ctx: PipelineContext) => Promise<T>,
  ): Promise<T | ProblemDetails>;
}

export interface RequestPipelineDeps {
  readonly rateLimiter: RateLimiter;
  /**
   * Derives the limiter key from the request. Defaults to the client IP.
   * Override for composite keys — e.g. `ip::tenantKey` for embed traffic —
   * when a policy must aggregate across dimensions.
   */
  readonly keyFor?: (request: PipelineRequest) => string;
  /**
   * Additional limiters checked AFTER the primary one (consumer/03). Each
   * enforces an independent budget on its own key dimension — e.g. the
   * estimates endpoint checks per-IP first, then per-tenant for embed
   * traffic, so one tenant can't starve the endpoint. `keyFor` returning
   * `undefined` skips that limiter for the request (non-embed traffic has
   * no tenant key). The first denial wins and produces the 429.
   */
  readonly extraLimiters?: ReadonlyArray<{
    readonly limiter: RateLimiter;
    readonly keyFor: (request: PipelineRequest) => string | undefined;
    /** Log label for the denied dimension (e.g. 'tenant'). */
    readonly label: string;
  }>;
  /**
   * Defaults to console. BE-3 injects the Functions context logger so
   * entries land in Application Insights with the correlation ID.
   */
  readonly logger?: (entry: LogEntry) => void;
}

const UNKNOWN_CLIENT = 'unknown';

/**
 * One-way hash of a client IP for log lines (HRD-03). Raw IPs are PII and
 * must never reach structured logs — the hash is enough to correlate
 * abuse patterns across entries.
 */
export function hashClientIp(clientIp: string): string {
  return createHash('sha256').update(clientIp, 'utf8').digest('hex');
}

export function createRequestPipeline(deps: RequestPipelineDeps): RequestPipeline {
  const {
    rateLimiter,
    keyFor = (request) => request.clientIp ?? UNKNOWN_CLIENT,
    extraLimiters = [],
    logger = (entry) => console[entry.level](entry.message),
  } = deps;

  return {
    async run<T>(
      request: PipelineRequest,
      handler: (ctx: PipelineContext) => Promise<T>,
    ): Promise<T | ProblemDetails> {
      const correlationId = ensureCorrelationId(request.headers);
      const ctx: PipelineContext = { correlationId, clientIp: request.clientIp };

      const verdict = rateLimiter.check(keyFor(request));
      if (!verdict.allowed) {
        logger({
          level: 'warn',
          message: `rate-limited clientIpHash=${hashClientIp(
            request.clientIp ?? UNKNOWN_CLIENT,
          )}`,
          correlationId,
        });
        return rateLimitedProblem(correlationId, verdict.retryAfterMs);
      }
      // Secondary dimensions (consumer/03): each extra limiter enforces its
      // own budget. Skipped when its keyFor has nothing to key on.
      for (const extra of extraLimiters) {
        const key = extra.keyFor(request);
        if (key === undefined) continue;
        const extraVerdict = extra.limiter.check(key);
        if (!extraVerdict.allowed) {
          logger({
            level: 'warn',
            // Hash the dimension key: tenant keys are builder credentials and
            // never reach logs in the clear, same rule as client IPs.
            message: `rate-limited dimension=${extra.label} keyHash=${hashClientIp(key)}`,
            correlationId,
          });
          return rateLimitedProblem(correlationId, extraVerdict.retryAfterMs);
        }
      }

      try {
        return await handler(ctx);
      } catch (error) {
        logger({
          level: 'error',
          message:
            error instanceof Error
              ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
              : `non-error thrown: ${String(error)}`,
          correlationId,
        });
        return toProblemDetails(error, correlationId);
      }
    },
  };
}
