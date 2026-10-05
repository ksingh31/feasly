import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn } from '@angular/router';
import { Store } from '@ngxs/store';
import { map, take } from 'rxjs/operators';
import { BuilderState } from './builder.state';
import { LoadBuilderSession } from './builder.actions';

/**
 * Builder billing guard (QA 2026-10-04): `/builder/billing`,
 * `/builder/invoices`, and `/builder/record-contract` are visible and
 * route-accessible only to `builder_admin` holders. Every billing
 * endpoint is backend-gated by `builder:billing` (admin-only), so a
 * builder_member reaching these pages gets a 403 on every call and a
 * retry-loop error state — the pages are nav-hidden AND route-guarded,
 * exactly like `/builder/team` (builderTeamGuard).
 *
 * Non-admin builder users are redirected to `/builder`; unauthenticated
 * visitors go through the standard builder auth guard first (this guard
 * assumes a session probe has a chance — it triggers one when the
 * session is still unknown).
 */
export const builderBillingGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);

  const isAdmin = store.selectSnapshot(BuilderState.isBuilderAdmin);
  const sessionLoaded = store.selectSnapshot(BuilderState.sessionLoaded);

  if (sessionLoaded) {
    return isAdmin
      ? true
      : router.createUrlTree(['/builder']);
  }

  // Session not probed yet — load it, then decide.
  return store.dispatch(new LoadBuilderSession()).pipe(
    take(1),
    map(() =>
      store.selectSnapshot(BuilderState.isBuilderAdmin)
        ? true
        : router.createUrlTree(['/builder']),
    ),
  );
};
