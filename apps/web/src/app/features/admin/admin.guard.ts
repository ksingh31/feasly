import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ConfigService } from '../../core/config/config.service';

/**
 * Interim admin route guard (admin/07 frontend).
 *
 * Until admin/01 (magic-link admin session auth) lands, admin routes are
 * guarded by the configured interim admin key: the guard passes when
 * `admin.adminKey` is a non-empty string, and redirects to `/` otherwise.
 *
 * PLACEHOLDER: replace this key check with the admin/01 session check
 * (HttpOnly session cookie) the moment that story merges. The guard's
 * contract — "block non-admins, redirect to /" — stays the same.
 */
export const adminGuard: CanActivateFn = () => {
  const config = inject(ConfigService);
  const router = inject(Router);
  const adminKey = config.get('admin').adminKey?.trim() ?? '';
  if (adminKey.length > 0) {
    return true;
  }
  return router.createUrlTree(['/']);
};
