import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { isServerPlatform } from '../../core/utils/platform';
import { WizardState } from './wizard.state';

/**
 * Gate/analyzing guard (FE-004).
 *
 * The lead gate and the analyzing screen need a selected property AND a
 * configured scope (the user reached at least the scope step). Deep links
 * with an empty or address-only wizard bounce to the address step (landing)
 * instead of rendering a dead-end page. Reads the rehydrated store — the
 * NGXS storage plugin restores persisted state during store init, before
 * route guards run.
 *
 * SSR-safe (issue #515): the server has no localStorage, so it always
 * activates and the browser guard decides after hydration.
 */
export const wizardScopeGuard: CanActivateFn = () => {
  if (isServerPlatform()) {
    return true;
  }
  const store = inject(Store);
  const router = inject(Router);
  const property = store.selectSnapshot(WizardState.property);
  const step = store.selectSnapshot(WizardState.step);
  return property !== null && step >= 2 ? true : router.createUrlTree(['/']);
};
