import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { throwError, TimeoutError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ApiError } from '@feasly/contracts';

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
