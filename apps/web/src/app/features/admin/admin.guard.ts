import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn } from '@angular/router';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { AdminAuthState } from './admin-auth.state';
import { LoadAdminSession } from './admin-auth.actions';

/**
 * Admin route guard (admin/01). Mirrors the builder guard (embed/09).
 *
 * Dispatches `LoadAdminSession` (probes `GET /api/v1/admin/auth/me` with
 * the bearer token from AdminAuthState) and maps the result:
 * - Authenticated → allow.
 * - No/invalid session → redirect to `/admin/login`.
 * - Expired session → `/admin/login?expired=1` (expiry copy).
 */
export const adminGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);

  return store.dispatch(new LoadAdminSession()).pipe(
    switchMap(() => {
      const expired = store.selectSnapshot(AdminAuthState.sessionExpired);
      const authenticated = store.selectSnapshot(AdminAuthState.authenticated);
      if (authenticated) {
        return of(true);
      }
      if (expired) {
        return of(router.createUrlTree(['/admin/login'], { queryParams: { expired: '1' } }));
      }
      return of(router.createUrlTree(['/admin/login']));
    }),
    // A dispatch-level failure (never expected) fails closed: login page.
    catchError(() => of(router.createUrlTree(['/admin/login']))),
    map((result) => result),
  );
};
