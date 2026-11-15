import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { isServerPlatform } from '../../core/utils/platform';
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
 *
 * SSR-safe (issue #515): the server has no localStorage, so it always
 * activates and the browser guard decides after hydration.
 */
export const reportEstimateGuard: CanActivateFn = () => {
  if (isServerPlatform()) {
    return true;
  }
  const store = inject(Store);
  const router = inject(Router);
  if (store.selectSnapshot(ReportState.reportToken)) {
    return true;
  }
  const property = store.selectSnapshot(WizardState.property);
  const inputs = store.selectSnapshot(WizardState.inputs);
  return property !== null && inputs.sqft > 0 ? true : router.createUrlTree(['/']);
};
