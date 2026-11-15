import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { isServerPlatform } from '../../core/utils/platform';
import { WizardState } from './wizard.state';

/**
 * Wizard deep-link guard (FE-2).
 *
 * The scope step never renders without a selected property: a deep link with
 * an empty wizard is redirected to the address step (landing) instead of
 * rendering a dead-end page. Reads the rehydrated store — the NGXS storage
 * plugin restores persisted state during store init, before route guards run.
 *
 * SSR-safe (issue #515): the server has no localStorage, so it always
 * activates and the browser guard decides after hydration.
 */
export const wizardPropertyGuard: CanActivateFn = () => {
  if (isServerPlatform()) {
    return true;
  }
  const store = inject(Store);
  const router = inject(Router);
  return store.selectSnapshot(WizardState.property) !== null
    ? true
    : router.createUrlTree(['/']);
};
