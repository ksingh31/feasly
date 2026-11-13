import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { WizardState } from '../wizard/wizard.state';
import { ReportState } from './report.state';

/**
 * Report deep-link guard (M1).
 *
 * The report page needs a completed estimate basis: a selected property and
 * configured scope (sqft > 0) — OR a verified report token (issue #484).
 * A magic-link / partner-share redemption on a fresh device has no wizard
 * state (it lives in the original browser's localStorage); the token alone
 * is enough, because `UnlockReport` hydrates property + inputs from
 * `GET /reports/{token}`. Deep links with neither redirect to the address
 * step instead of rendering an empty report.
 */
export const reportEstimateGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);
  if (store.selectSnapshot(ReportState.reportToken)) {
    return true;
  }
  const property = store.selectSnapshot(WizardState.property);
  const inputs = store.selectSnapshot(WizardState.inputs);
  return property !== null && inputs.sqft > 0 ? true : router.createUrlTree(['/']);
};
