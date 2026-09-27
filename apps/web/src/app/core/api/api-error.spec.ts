import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { toApiError } from './api-error';

function capture(error: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    toApiError(error).subscribe({ error: (e: unknown) => resolve(e) });
  });
}

describe('toApiError', () => {
  it('marks a client-side timeout as retryable', async () => {
    const err = await capture(new TimeoutError());
    expect(err).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('still marks 5xx as retryable and 4xx as not', async () => {
    const server = await capture(
      new HttpErrorResponse({ status: 500, error: { code: 'INTERNAL_ERROR' } }),
    );
    expect(server).toMatchObject({ retryable: true });

    const client = await capture(
      new HttpErrorResponse({ status: 401, error: { code: 'UNAUTHENTICATED' } }),
    );
    expect(client).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
  });
});
