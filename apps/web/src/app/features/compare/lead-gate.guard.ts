import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { isServerPlatform } from '../../core/utils/platform';
import { WizardState } from '../wizard/wizard.state';
import { ComparisonState } from './comparison.state';

/**
 * Lead-gate guard (NBH-03): the single gate serves two flows.
 *
 * - Wizard flow (FE-004): needs a selected property AND a configured scope
 *   (the user reached at least the scope step).
 * - Comparison flow (NBH-03): needs an active comparison result — no
 *   property, no wizard scope.
 *
 * Deep links satisfying neither bounce to the landing page instead of
 * rendering a dead-end gate. Reads the rehydrated store — the NGXS storage
 * plugin restores persisted state during store init, before route guards run.
 *
 * SSR-safe (issue #515): the server has no localStorage, so it always
 * activates and the browser guard decides after hydration.
 */
export const leadGateGuard: CanActivateFn = () => {
  if (isServerPlatform()) {
    return true;
  }
  const store = inject(Store);
  const router = inject(Router);

  const property = store.selectSnapshot(WizardState.property);
  const step = store.selectSnapshot(WizardState.step);
  if (property !== null && step >= 2) {
    return true;
  }

  if (store.selectSnapshot(ComparisonState.result) !== null) {
    return true;
  }

  return router.createUrlTree(['/']);
};
