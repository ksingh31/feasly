/**
 * Request pipeline (BE0-003): correlation → rate limit → handler → errors.
 *
 * Framework-agnostic on purpose: BE-3's Azure Functions trigger adapters
 * build the `PipelineRequest` from the Functions request object and hand the
 * pipeline a thin route handler. Public routes run through this pipeline;
 * BE-4 adds authentication in front of it for dashboard/admin routes.
 */
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
   * Defaults to console. BE-3 injects the Functions context logger so
   * entries land in Application Insights with the correlation ID.
   */
  readonly logger?: (entry: LogEntry) => void;
}

const UNKNOWN_CLIENT = 'unknown';

export function createRequestPipeline(deps: RequestPipelineDeps): RequestPipeline {
  const { rateLimiter, logger = (entry) => console[entry.level](entry.message) } =
    deps;

  return {
    async run<T>(
      request: PipelineRequest,
      handler: (ctx: PipelineContext) => Promise<T>,
    ): Promise<T | ProblemDetails> {
      const correlationId = ensureCorrelationId(request.headers);
      const ctx: PipelineContext = { correlationId, clientIp: request.clientIp };

      const verdict = rateLimiter.check(request.clientIp ?? UNKNOWN_CLIENT);
      if (!verdict.allowed) {
        logger({
          level: 'warn',
          message: `rate-limited clientIp=${request.clientIp ?? UNKNOWN_CLIENT}`,
          correlationId,
        });
        return rateLimitedProblem(correlationId, verdict.retryAfterMs);
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
