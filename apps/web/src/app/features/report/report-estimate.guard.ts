import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { WizardState } from '../wizard/wizard.state';

/**
 * Report deep-link guard (M1).
 *
 * The report page needs a completed estimate basis: a selected property and
 * configured scope (sqft > 0). Deep links without one redirect to the address
 * step instead of rendering an empty report.
 */
export const reportEstimateGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);
  const property = store.selectSnapshot(WizardState.property);
  const inputs = store.selectSnapshot(WizardState.inputs);
  return property !== null && inputs.sqft > 0 ? true : router.createUrlTree(['/']);
};
