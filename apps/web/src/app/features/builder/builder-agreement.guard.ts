import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn } from '@angular/router';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { catchError, map, take } from 'rxjs/operators';
import { LoadBuilderAgreement } from './builder-onboarding.actions';
import { BuilderOnboardingState } from './builder-onboarding.state';
import { agreementUrlTree } from './builder-agreement-gate';

/**
 * Agreement guard (#722): money pages (`/builder/money`, `/billing`,
 * `/invoices`) require the org's acceptance of the CURRENT platform
 * agreement. A builder without one is sent to `/builder/agreement`
 * (with `returnUrl`) first.
 *
 * A cached "current" status passes straight through; anything else is
 * re-fetched (another admin may have just accepted). If the status can't
 * be loaded the guard lets the page open — the server still refuses every
 * money call with 409 AGREEMENT_REQUIRED, and that is routed here too
 * (BuilderAgreementGate), so the guarantee never depends on this guard.
 *
 * Runs after builderBillingGuard (members are already sent home there).
 */
export const builderAgreementGuard: CanActivateFn = (_route, state) => {
  const store = inject(Store);
  const router = inject(Router);

  if (store.selectSnapshot(BuilderOnboardingState.agreementCurrent) === true) {
    return of(true);
  }
  return store.dispatch(new LoadBuilderAgreement()).pipe(
    take(1),
    map(() =>
      store.selectSnapshot(BuilderOnboardingState.agreementCurrent) === false
        ? agreementUrlTree(router, state.url)
        : true,
    ),
    catchError(() => of(true)),
  );
};
