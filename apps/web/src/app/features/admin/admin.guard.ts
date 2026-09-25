import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn } from '@angular/router';
import { map, of } from 'rxjs';
import { catchError } from 'rxjs';
import { AdminAuthApiService } from './admin-auth-api.service';

/**
 * Admin route guard (admin/01).
 *
 * Checks the session via `GET /api/v1/admin/auth/me` (cookie-based).
 * - No/invalid session → redirect to `/admin/login`.
 * - Expired session (401 with a specific marker) → `/admin/login?expired=1`.
 *
 * The backend distinguishes expired from invalid; the frontend maps that
 * to the exact expiry copy on the login page.
 */
export const adminGuard: CanActivateFn = () => {
  const api = inject(AdminAuthApiService);
  const router = inject(Router);

  return api.me().pipe(
    map((me) => {
      if (me !== null) return true;
      return router.createUrlTree(['/admin/login']);
    }),
    catchError((error: unknown) => {
      // 401 with SESSION_EXPIRED → show the expiry copy.
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code: unknown }).code
          : null;
      if (code === 'SESSION_EXPIRED') {
        return of(router.createUrlTree(['/admin/login'], { queryParams: { expired: '1' } }));
      }
      return of(router.createUrlTree(['/admin/login']));
    }),
  );
};
