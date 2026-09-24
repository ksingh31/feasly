import { describe, expect, it } from 'vitest';
import type { ApiError } from '@feasly/contracts';
import {
  ErrorCodes,
  HttpError,
  isProblemDetails,
  problemResponseHeaders,
  rateLimitedProblem,
  toProblemDetails,
} from '../src/middleware/errors';

const CID = 'test-correlation-id';

describe('toProblemDetails — error mapping table', () => {
  const cases: Array<{
    error: HttpError;
    status: number;
    code: string;
    title: string;
    retryable: boolean;
  }> = [
    {
      error: new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'sqft is required'),
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Bad Request',
      retryable: false,
    },
    {
      error: new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Missing credentials'),
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'Unauthorized',
      retryable: false,
    },
    {
      error: new HttpError(403, ErrorCodes.FORBIDDEN, 'Wrong role'),
      status: 403,
      code: 'FORBIDDEN',
      title: 'Forbidden',
      retryable: false,
    },
    {
      error: new HttpError(404, ErrorCodes.NOT_FOUND, 'No such estimate'),
      status: 404,
      code: 'NOT_FOUND',
      title: 'Not Found',
      retryable: false,
    },
    {
      error: new HttpError(429, ErrorCodes.RATE_LIMITED, 'Slow down'),
      status: 429,
      code: 'RATE_LIMITED',
      title: 'Too Many Requests',
      retryable: true,
    },
    {
      error: new HttpError(503, ErrorCodes.DEPENDENCY_UNAVAILABLE, 'DB down', true),
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      title: 'Service Unavailable',
      retryable: true,
    },
  ];

  for (const { error, status, code, title, retryable } of cases) {
    it(`maps ${status} ${code}`, () => {
      const problem = toProblemDetails(error, CID);
      expect(problem.status).toBe(status);
      expect(problem.code).toBe(code);
      expect(problem.title).toBe(title);
      expect(problem.detail).toBe(error.message);
      expect(problem.retryable).toBe(retryable);
      expect(problem.correlationId).toBe(CID);
      expect(problem.type).toMatch(/^urn:feasly:errors:/);
    });
  }

  it('an explicit retryable=false survives on a 5xx', () => {
    const problem = toProblemDetails(
      new HttpError(500, ErrorCodes.INTERNAL_ERROR, 'known-fatal', false),
      CID,
    );
    expect(problem.retryable).toBe(false);
  });
});

describe('toProblemDetails — unknown throws', () => {
  it('a rogue Error becomes a generic 500 with no leak', () => {
    const problem = toProblemDetails(new Error('db password=hunter2'), CID);
    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toBe('An unexpected error occurred.');
    expect(problem.correlationId).toBe(CID);
    const serialized = JSON.stringify(problem);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('stack');
  });

  it('non-Error throws (string, null) also become a generic 500', () => {
    for (const thrown of ['boom', null, undefined, 42]) {
      const problem = toProblemDetails(thrown, CID);
      expect(problem.status).toBe(500);
      expect(problem.code).toBe('INTERNAL_ERROR');
    }
  });
});

describe('ApiError contract reconciliation', () => {
  it('every ProblemDetails satisfies the frontend ApiError contract', () => {
    const problems = [
      toProblemDetails(new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'bad'), CID),
      toProblemDetails(new Error('rogue'), CID),
      rateLimitedProblem(CID, 1234),
    ];
    for (const problem of problems) {
      // Compile-time: ProblemDetails extends ApiError. Runtime: fields exist.
      const asApiError: ApiError = problem;
      expect(typeof asApiError.code).toBe('string');
      expect(typeof asApiError.message).toBe('string');
      expect(typeof asApiError.retryable).toBe('boolean');
    }
  });

  it('rateLimitedProblem carries the RATE_LIMITED code and retry hint', () => {
    const problem = rateLimitedProblem(CID, 45000);
    expect(problem.status).toBe(429);
    expect(problem.code).toBe('RATE_LIMITED');
    expect(problem.retryAfterMs).toBe(45000);
    expect(problem.correlationId).toBe(CID);
  });
});

describe('isProblemDetails', () => {
  it('narrows problem shapes', () => {
    expect(isProblemDetails(toProblemDetails(new Error('x'), CID))).toBe(true);
    expect(isProblemDetails({ ok: true })).toBe(false);
    expect(isProblemDetails(null)).toBe(false);
    expect(isProblemDetails('nope')).toBe(false);
  });
});

describe('problemResponseHeaders', () => {
  it('adds Retry-After in whole seconds on 429s', () => {
    const headers = problemResponseHeaders(rateLimitedProblem(CID, 61_500));
    expect(headers['Content-Type']).toBe('application/problem+json');
    expect(headers['Retry-After']).toBe('62');
  });

  it('never emits Retry-After: 0', () => {
    const headers = problemResponseHeaders(rateLimitedProblem(CID, 100));
    expect(headers['Retry-After']).toBe('1');
  });

  it('omits Retry-After on non-429 problems', () => {
    const headers = problemResponseHeaders(
      toProblemDetails(new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'bad'), CID),
    );
    expect(headers['Retry-After']).toBeUndefined();
  });
});
