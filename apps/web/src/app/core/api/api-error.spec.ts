import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { toApiError, toBlobApiError } from './api-error';

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
