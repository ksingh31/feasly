import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { ConnectivityService } from './connectivity.service';

/**
 * Network-failure tripwire (HRD-02): any API request that fails at the
 * network layer (status 0) asks the ConnectivityService to re-verify
 * reachability via the health probe. The probe request itself is skipped —
 * its own failure IS the signal, and skipping it avoids probe loops.
 */
export const connectivityInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.includes('/api/health')) {
    return next(req);
  }
  const connectivity = inject(ConnectivityService);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 0) {
        connectivity.markUnreachable();
      }
      return throwError(() => error);
    }),
  );
};
