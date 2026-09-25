/**
 * Error middleware (BE0-003): thrown errors become RFC 7807 ProblemDetails.
 *
 * Reconciliation (deliberate): the backend's error contract is RFC 7807, and
 * every ProblemDetails ALSO satisfies the frontend's `ApiError` contract
 * (`code` / `message` / `retryable` from `@feasly/contracts`) — `message` and
 * `detail` carry the same human-readable text. The UI reads the three
 * ApiError fields off any error response without knowing RFC 7807.
 *
 * Security: unknown throws become a generic 500. The original message and
 * stack NEVER reach the client — they go to the injected logger together
 * with the correlation ID.
 */
import type { ApiError } from '@feasly/contracts';

/** RFC 7807 problem that structurally satisfies the ApiError contract. */
export interface ProblemDetails extends ApiError {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly correlationId: string;
  /** RFC 7807 extension member, present on 429s. */
  readonly retryAfterMs?: number;
}

/** Machine-readable error codes shared by routes, services and middleware. */
export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  COMMUNITY_NOT_FOUND: 'COMMUNITY_NOT_FOUND',
  UNKNOWN_TENANT: 'UNKNOWN_TENANT',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/**
 * An expected failure with an HTTP status. Throw these from services/routes
 * for anything the client caused or should handle; anything else becomes a
 * generic 500 via {@link toProblemDetails}.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable?: boolean) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    // 429s and 5xx are worth one retry unless the thrower says otherwise.
    this.retryable = retryable ?? (status === 429 || status >= 500);
  }
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** URN namespace — a URI as RFC 7807 requires, without a fetchable host. */
function errorType(code: string): string {
  return `urn:feasly:errors:${code.toLowerCase().replace(/_/g, '-')}`;
}

function unexpectedProblem(correlationId: string): ProblemDetails {
  const message = 'An unexpected error occurred.';
  return {
    type: errorType(ErrorCodes.INTERNAL_ERROR),
    title: 'Internal Server Error',
    status: 500,
    detail: message,
    code: ErrorCodes.INTERNAL_ERROR,
    message,
    // Unknown failures are not known-safe to retry; explicit HttpError(500)
    // throwers opt into retryable themselves.
    retryable: false,
    correlationId,
  };
}

/** Map any thrown value to a client-safe ProblemDetails. Never leaks stacks. */
export function toProblemDetails(error: unknown, correlationId: string): ProblemDetails {
  if (error instanceof HttpError) {
    return {
      type: errorType(error.code),
      title: STATUS_TITLES[error.status] ?? 'Error',
      status: error.status,
      detail: error.message,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId,
    };
  }
  return unexpectedProblem(correlationId);
}

/** 429 with the `RATE_LIMITED` code and a retry hint for the client. */
export function rateLimitedProblem(
  correlationId: string,
  retryAfterMs: number,
): ProblemDetails {
  return {
    ...toProblemDetails(
      new HttpError(429, ErrorCodes.RATE_LIMITED, 'Too many requests. Please try again shortly.'),
      correlationId,
    ),
    retryAfterMs,
  };
}

/** Narrow `T | ProblemDetails` pipeline results. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['status'] === 'number' &&
    typeof v['code'] === 'string' &&
    typeof v['correlationId'] === 'string'
  );
}

/**
 * HTTP response headers for a ProblemDetails body (HRD-03). 429s carry a
 * `Retry-After` header in whole seconds (ceil, minimum 1) so well-behaved
 * clients — and the acceptance tests — don't have to parse the body.
 */
export function problemResponseHeaders(
  problem: ProblemDetails,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/problem+json',
  };
  if (problem.status === 429 && typeof problem.retryAfterMs === 'number') {
    headers['Retry-After'] = String(
      Math.max(1, Math.ceil(problem.retryAfterMs / 1000)),
    );
  }
  return headers;
}
