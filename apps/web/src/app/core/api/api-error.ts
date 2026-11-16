import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { from, of, switchMap, throwError, TimeoutError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { ApiError, ChallengeRequiredError } from '@feasly/contracts';

/**
 * Maps an HTTP failure onto the contract ApiError envelope.
 * 5xx, network failures (status 0) and client-side timeouts are retryable;
 * anything else isn't. Shared by the backend client and the backend
 * property-data service.
 */
export function toApiError(error: unknown): Observable<never> {
  if (error instanceof TimeoutError) {
    // rxjs `timeout()` (see AdminAuthApiService.call): the request may
    // still complete server-side (e.g. Azure cold start), so callers must
    // treat this as transient, not as a definitive failure.
    return throwError(
      (): ApiError => ({ code: 'timeout', message: 'Request timed out. Please try again.', retryable: true }),
    );
  }
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ApiError> | undefined;
    return throwError((): ApiError => {
      const code = typeof body?.code === 'string' ? body.code : `http_${error.status}`;
      const message =
        typeof body?.message === 'string' && body.message.length > 0
          ? body.message
          : 'Request failed. Please try again.';
      const retryable =
        error.status === 0 || error.status >= HttpStatusCode.InternalServerError;
      return { code, message, retryable };
    });
  }
  return throwError(
    (): ApiError => ({ code: 'unknown', message: 'Request failed. Please try again.', retryable: false }),
  );
}

/**
 * Blob-aware variant of {@link toApiError} for `responseType: 'blob'`
 * downloads (admin CSV export).
 *
 * When the backend rejects a blob request the error body arrives as a Blob
 * containing the problem+json payload — `toApiError` can't read `code` /
 * `message` off a Blob, so every failure degrades to the generic
 * "Request failed. Please try again." and the real status/message is lost
 * (2026-09-28: masked a transient failure as a broken export feature).
 * This reads the blob as text first and surfaces the server's message.
 * Non-blob errors delegate to {@link toApiError}.
 */
export function toBlobApiError(error: unknown): Observable<never> {
  if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
    return from(error.error.text()).pipe(
      catchError(() => of('')),
      switchMap((text) => {
        let body: Partial<ApiError> | undefined;
        try {
          body = text ? (JSON.parse(text) as Partial<ApiError>) : undefined;
        } catch {
          body = undefined;
        }
        const message =
          typeof body?.message === 'string' && body.message.length > 0
            ? body.message
            : `Export failed (HTTP ${error.status}). Please try again.`;
        const code =
          typeof body?.code === 'string' ? body.code : `http_${error.status}`;
        const retryable =
          error.status === 0 || error.status >= HttpStatusCode.InternalServerError;
        return throwError(
          (): ApiError => ({ code, message, retryable }),
        );
      }),
    );
  }
  return toApiError(error);
}

/** API error codes that ask the client to run the bot challenge (#788). */
const CHALLENGE_CODES: ReadonlySet<string> = new Set(['CHALLENGE_REQUIRED', 'CHALLENGE_FAILED']);

/**
 * #905: the Turnstile site key from a 403 CHALLENGE_REQUIRED /
 * CHALLENGE_FAILED response, or null when `error` is anything else. Read
 * before {@link toApiError}, which drops the `challenge` field.
 */
export function challengeSiteKey(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== HttpStatusCode.Forbidden) {
    return null;
  }
  const body = error.error as Partial<ChallengeRequiredError> | null | undefined;
  if (typeof body !== 'object' || body === null) return null;
  if (typeof body.code !== 'string' || !CHALLENGE_CODES.has(body.code)) return null;
  const challenge = body.challenge;
  if (challenge?.provider !== 'turnstile') return null;
  return typeof challenge.siteKey === 'string' && challenge.siteKey.length > 0
    ? challenge.siteKey
    : null;
}
