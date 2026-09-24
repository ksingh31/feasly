import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ApiError } from '@feasly/contracts';

/**
 * Maps an HTTP failure onto the contract ApiError envelope.
 * 5xx and network failures (status 0) are retryable; anything else isn't.
 * Shared by the backend client and the backend property-data service.
 */
export function toApiError(error: unknown): Observable<never> {
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
