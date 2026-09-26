import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn } from '@angular/router';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { BuilderState } from './builder.state';
import { LoadBuilderSession } from './builder.actions';

/**
 * Builder route guard (embed/09). Mirrors the admin/01 guard.
 *
 * Dispatches `LoadBuilderSession` (probes `GET /api/v1/builder/auth/me`
 * against the HttpOnly session cookie) and maps the result:
 * - Authenticated → allow.
 * - No/invalid session → redirect to `/builder/login`.
 * - Expired session → `/builder/login?expired=1` (expiry copy).
 */
export const builderGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);

  return store.dispatch(new LoadBuilderSession()).pipe(
    switchMap(() => {
      const expired = store.selectSnapshot(BuilderState.sessionExpired);
      const authenticated = store.selectSnapshot(BuilderState.authenticated);
      if (authenticated) {
        return of(true);
      }
      if (expired) {
        return of(
          router.createUrlTree(['/builder/login'], { queryParams: { expired: '1' } }),
        );
      }
      return of(router.createUrlTree(['/builder/login']));
    }),
    // A dispatch-level failure (never expected) fails closed: login page.
    catchError(() => of(router.createUrlTree(['/builder/login']))),
    map((result) => result),
  );
};
