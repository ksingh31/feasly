import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { WizardState } from './wizard.state';

/**
 * Wizard deep-link guard (FE-2).
 *
 * The scope step never renders without a selected property: a deep link with
 * an empty wizard is redirected to the address step (landing) instead of
 * rendering a dead-end page. Reads the rehydrated store — the NGXS storage
 * plugin restores persisted state during store init, before route guards run.
 */
export const wizardPropertyGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);
  return store.selectSnapshot(WizardState.property) !== null
    ? true
    : router.createUrlTree(['/']);
};
