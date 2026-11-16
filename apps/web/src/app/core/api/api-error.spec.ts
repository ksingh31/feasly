import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { challengeSiteKey, toApiError, toBlobApiError } from './api-error';

function capture(
  mapper: (error: unknown) => { subscribe(o: { error: (e: unknown) => void }): void },
  error: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    mapper(error).subscribe({ error: (e: unknown) => resolve(e) });
  });
}

function captureApiError(error: unknown): Promise<unknown> {
  return capture(toApiError, error);
}

function captureBlobApiError(error: unknown): Promise<unknown> {
  return capture(toBlobApiError, error);
}

describe('toApiError', () => {
  it('marks a client-side timeout as retryable', async () => {
    const err = await captureApiError(new TimeoutError());
    expect(err).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('still marks 5xx as retryable and 4xx as not', async () => {
    const server = await captureApiError(
      new HttpErrorResponse({ status: 500, error: { code: 'INTERNAL_ERROR' } }),
    );
    expect(server).toMatchObject({ retryable: true });

    const client = await captureApiError(
      new HttpErrorResponse({ status: 401, error: { code: 'UNAUTHENTICATED' } }),
    );
    expect(client).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
  });
});

describe('toBlobApiError', () => {
  const blobError = (status: number, body: string): HttpErrorResponse =>
    new HttpErrorResponse({
      status,
      error: new Blob([body], { type: 'application/problem+json' }),
    });

  it('surfaces the server message from a blob error body', async () => {
    const err = await captureBlobApiError(
      blobError(
        503,
        JSON.stringify({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Function host is restarting. Please try again.',
        }),
      ),
    );
    // 2026-09-28: the CSV export showed only "Request failed. Please try
    // again." for a blob failure — the real message must reach the toast.
    expect(err).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Function host is restarting. Please try again.',
      retryable: true,
    });
  });

  it('falls back to a status-bearing message for an unreadable blob body', async () => {
    const err = await captureBlobApiError(blobError(500, 'not-json{{{'));
    expect(err).toMatchObject({
      code: 'http_500',
      message: 'Export failed (HTTP 500). Please try again.',
      retryable: true,
    });
  });

  it('marks blob 4xx as not retryable', async () => {
    const err = await captureBlobApiError(
      blobError(403, JSON.stringify({ code: 'FORBIDDEN' })),
    );
    expect(err).toMatchObject({ code: 'FORBIDDEN', retryable: false });
  });

  it('delegates non-blob errors to toApiError', async () => {
    const err = await captureBlobApiError(
      new HttpErrorResponse({ status: 401, error: { code: 'UNAUTHENTICATED' } }),
    );
    expect(err).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
  });
});

describe('challengeSiteKey (#905)', () => {
  const challenge403 = (body: unknown, status = 403): HttpErrorResponse =>
    new HttpErrorResponse({ status, error: body });
  const body = (code: string, siteKey: unknown = 'site-key-from-api') => ({
    code,
    message: 'Please confirm you are not a bot, then try again.',
    retryable: false,
    challenge: { provider: 'turnstile', siteKey },
  });

  it('reads the site key from CHALLENGE_REQUIRED and CHALLENGE_FAILED 403s', () => {
    expect(challengeSiteKey(challenge403(body('CHALLENGE_REQUIRED')))).toBe('site-key-from-api');
    expect(challengeSiteKey(challenge403(body('CHALLENGE_FAILED')))).toBe('site-key-from-api');
  });

  it('ignores other statuses, codes, providers, and missing keys', () => {
    expect(challengeSiteKey(challenge403(body('CHALLENGE_REQUIRED'), 429))).toBeNull();
    expect(challengeSiteKey(challenge403(body('FORBIDDEN')))).toBeNull();
    expect(challengeSiteKey(challenge403(body('CHALLENGE_REQUIRED', '')))).toBeNull();
    expect(challengeSiteKey(challenge403(body('CHALLENGE_REQUIRED', 42)))).toBeNull();
    expect(
      challengeSiteKey(
        challenge403({ ...body('CHALLENGE_REQUIRED'), challenge: { provider: 'other', siteKey: 'k' } }),
      ),
    ).toBeNull();
    expect(challengeSiteKey(challenge403({ code: 'CHALLENGE_REQUIRED' }))).toBeNull();
    expect(challengeSiteKey(challenge403(null))).toBeNull();
    expect(challengeSiteKey(new Error('nope'))).toBeNull();
  });
});
