/**
 * Agreement guard (#722): money routes require a current acceptance.
 *
 * - Cached current → allowed without a request.
 * - Not accepted → redirected to /builder/agreement?returnUrl=<url>.
 * - Status unknown after a failed load → allowed (server still refuses).
 */
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type UrlTree } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { firstValueFrom, isObservable, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { builderAgreementGuard } from './builder-agreement.guard';
import { BuilderOnboardingApiService } from './builder-onboarding-api.service';
import { LoadBuilderAgreement } from './builder-onboarding.actions';
import { BuilderChecklistState, BuilderOnboardingState } from './builder-onboarding.state';
import { AGREEMENT_ACCEPTED, AGREEMENT_PENDING } from './test-helpers/onboarding.fixtures';

function setup(getAgreement: () => Observable<unknown>) {
  TestBed.resetTestingModule();
  const api = { getAgreement: vi.fn(getAgreement) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideStore([BuilderOnboardingState, BuilderChecklistState]),
      { provide: BuilderOnboardingApiService, useValue: api },
    ],
  });
  return { api, store: TestBed.inject(Store), router: TestBed.inject(Router) };
}

async function run(url = '/builder/money'): Promise<boolean | UrlTree> {
  const result = TestBed.runInInjectionContext(() =>
    builderAgreementGuard({} as never, { url } as never),
  );
  return (isObservable(result) ? await firstValueFrom(result) : result) as boolean | UrlTree;
}

describe('builderAgreementGuard (#722)', () => {
  it('allows a builder whose org accepted the current version', async () => {
    const { api } = setup(() => of(AGREEMENT_ACCEPTED));
    expect(await run()).toBe(true);
    expect(api.getAgreement).toHaveBeenCalledTimes(1);
    // Cached current: no second request.
    expect(await run()).toBe(true);
    expect(api.getAgreement).toHaveBeenCalledTimes(1);
  });

  it('sends a builder without a current acceptance to the agreement', async () => {
    const { router } = setup(() => of(AGREEMENT_PENDING));
    const result = await run('/builder/billing');
    expect(router.serializeUrl(result as UrlTree)).toBe(
      '/builder/agreement?returnUrl=%2Fbuilder%2Fbilling',
    );
  });

  it('re-checks a cached "not current" status (another admin may have accepted)', async () => {
    let response = AGREEMENT_PENDING;
    const { store } = setup(() => of(response));
    store.dispatch(new LoadBuilderAgreement());
    response = AGREEMENT_ACCEPTED;
    expect(await run()).toBe(true);
  });

  it('lets the page open when the status cannot be loaded', async () => {
    setup(() => throwError(() => ({ code: 'http_500' })));
    expect(await run()).toBe(true);
  });
});
