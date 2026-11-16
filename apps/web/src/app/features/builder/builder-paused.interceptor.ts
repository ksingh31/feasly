import { HttpErrorResponse, HttpStatusCode, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Store } from '@ngxs/store';
import { tap } from 'rxjs';
import { BuilderAccountPaused } from './builder.actions';

/** The API error code for a builder whose status refuses the call (#860). */
export const BUILDER_PAUSED_CODE = 'BUILDER_PAUSED';

/** Builder-portal API paths (the embed and consumer traffic never pause the portal). */
const BUILDER_API_SEGMENT = '/api/v1/builder/';

/**
 * #861: when a builder-portal call comes back 403 BUILDER_PAUSED (the org
 * is suspended, offboarding or closed), flag it in BuilderState so the
 * shell swaps the page for a clear "Your account is paused — contact
 * Feasly" screen instead of a generic error. The error still reaches the
 * caller unchanged; this only observes it.
 */
export const builderPausedInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.includes(BUILDER_API_SEGMENT)) return next(req);
  const store = inject(Store);
  return next(req).pipe(
    tap({
      error: (err: unknown) => {
        if (!(err instanceof HttpErrorResponse) || err.status !== HttpStatusCode.Forbidden) return;
        const body = err.error as { code?: unknown; message?: unknown } | null;
        if (body?.code !== BUILDER_PAUSED_CODE) return;
        store.dispatch(new BuilderAccountPaused(typeof body.message === 'string' ? body.message : null));
      },
    }),
  );
};
