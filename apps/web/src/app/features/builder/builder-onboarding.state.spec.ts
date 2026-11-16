/**
 * Builder onboarding state (#722): agreement + checklist loads, accept
 * (success refreshes the checklist; version mismatch reloads the new
 * text; member 403), the 409 "required" downgrade, and checklist
 * dismissal per org.
 */
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { BuilderOnboardingApiService } from './builder-onboarding-api.service';
import {
  AcceptBuilderAgreement,
  DismissOnboardingStep,
  LoadBuilderAgreement,
  LoadBuilderOnboarding,
  MarkBuilderAgreementRequired,
} from './builder-onboarding.actions';
import { BuilderChecklistState, BuilderOnboardingState } from './builder-onboarding.state';
import { AGREEMENT_ACCEPTED, AGREEMENT_PENDING, onboardingOf } from './test-helpers/onboarding.fixtures';

function setup(api: Partial<Record<keyof BuilderOnboardingApiService, unknown>>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideStore([BuilderOnboardingState, BuilderChecklistState]),
      { provide: BuilderOnboardingApiService, useValue: api },
    ],
  });
  return TestBed.inject(Store);
}

describe('BuilderOnboardingState (#722)', () => {
  it('loads the agreement status', () => {
    const store = setup({ getAgreement: vi.fn(() => of(AGREEMENT_PENDING)) });
    store.dispatch(new LoadBuilderAgreement());
    expect(store.selectSnapshot(BuilderOnboardingState.agreement)).toEqual(AGREEMENT_PENDING);
    expect(store.selectSnapshot(BuilderOnboardingState.agreementStatus)).toBe('ready');
    expect(store.selectSnapshot(BuilderOnboardingState.agreementCurrent)).toBe(false);
  });

  it('marks a failed agreement load as error and keeps current unknown', () => {
    const store = setup({ getAgreement: vi.fn(() => throwError(() => ({ code: 'http_500' }))) });
    store.dispatch(new LoadBuilderAgreement());
    expect(store.selectSnapshot(BuilderOnboardingState.agreementStatus)).toBe('error');
    expect(store.selectSnapshot(BuilderOnboardingState.agreementCurrent)).toBeNull();
  });

  it('loads onboarding and mirrors its agreement status', () => {
    const onboarding = onboardingOf({ agreement: AGREEMENT_ACCEPTED, agreementAccepted: true });
    const store = setup({ getOnboarding: vi.fn(() => of(onboarding)) });
    store.dispatch(new LoadBuilderOnboarding());
    expect(store.selectSnapshot(BuilderOnboardingState.onboarding)).toEqual(onboarding);
    expect(store.selectSnapshot(BuilderOnboardingState.agreementCurrent)).toBe(true);
  });

  it('accepts the version, then refreshes the checklist', () => {
    const acceptAgreement = vi.fn(() => of(AGREEMENT_ACCEPTED));
    const getOnboarding = vi.fn(() =>
      of(onboardingOf({ agreementAccepted: true, agreement: AGREEMENT_ACCEPTED })),
    );
    const store = setup({ acceptAgreement, getOnboarding });
    store.dispatch(new AcceptBuilderAgreement('v2'));
    expect(acceptAgreement).toHaveBeenCalledWith('v2');
    expect(getOnboarding).toHaveBeenCalledTimes(1);
    expect(store.selectSnapshot(BuilderOnboardingState.agreementCurrent)).toBe(true);
    expect(store.selectSnapshot(BuilderOnboardingState.onboarding)?.agreementAccepted).toBe(true);
    expect(store.selectSnapshot(BuilderOnboardingState.accepting)).toBe(false);
    expect(store.selectSnapshot(BuilderOnboardingState.acceptError)).toBeNull();
  });

  it('on a version mismatch, flags it and reloads the newer text', () => {
    const newer = { ...AGREEMENT_PENDING, version: 'v3', document: { ...AGREEMENT_PENDING.document, version: 'v3' } };
    const getAgreement = vi.fn(() => of(newer));
    const store = setup({
      acceptAgreement: vi.fn(() => throwError(() => ({ code: 'AGREEMENT_VERSION_MISMATCH' }))),
      getAgreement,
    });
    store.dispatch(new AcceptBuilderAgreement('v2'));
    expect(store.selectSnapshot(BuilderOnboardingState.acceptError)).toBe('versionChanged');
    expect(getAgreement).toHaveBeenCalledTimes(1);
    expect(store.selectSnapshot(BuilderOnboardingState.agreement)?.version).toBe('v3');
  });

  it('maps a member 403 and a generic failure', () => {
    const store = setup({
      acceptAgreement: vi
        .fn()
        .mockReturnValueOnce(throwError(() => ({ code: 'AGREEMENT_ADMIN_REQUIRED' })))
        .mockReturnValueOnce(throwError(() => ({ code: 'http_500' }))),
    });
    store.dispatch(new AcceptBuilderAgreement('v2'));
    expect(store.selectSnapshot(BuilderOnboardingState.acceptError)).toBe('adminRequired');
    store.dispatch(new AcceptBuilderAgreement('v2'));
    expect(store.selectSnapshot(BuilderOnboardingState.acceptError)).toBe('failed');
    expect(store.selectSnapshot(BuilderOnboardingState.accepting)).toBe(false);
  });

  it('a 409 AGREEMENT_REQUIRED downgrades the cached status', () => {
    const store = setup({
      getOnboarding: vi.fn(() =>
        of(onboardingOf({ agreementAccepted: true, complete: true, agreement: AGREEMENT_ACCEPTED })),
      ),
    });
    store.dispatch(new LoadBuilderOnboarding());
    store.dispatch(new MarkBuilderAgreementRequired());
    expect(store.selectSnapshot(BuilderOnboardingState.agreementCurrent)).toBe(false);
    const onboarding = store.selectSnapshot(BuilderOnboardingState.onboarding);
    expect(onboarding?.agreementAccepted).toBe(false);
    expect(onboarding?.complete).toBe(false);
  });

  it('records checklist dismissals per org, once each', () => {
    const store = setup({});
    store.dispatch(new DismissOnboardingStep('org-a', 'team'));
    store.dispatch(new DismissOnboardingStep('org-a', 'team'));
    store.dispatch(new DismissOnboardingStep('org-b', 'profile'));
    expect(store.selectSnapshot(BuilderChecklistState.dismissed)).toEqual({
      'org-a': ['team'],
      'org-b': ['profile'],
    });
  });
});
