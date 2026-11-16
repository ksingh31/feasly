/**
 * First-run checklist (#722): one row per step mirroring the server flag,
 * links where a page exists (admin-only pages hidden from members),
 * dismissal of done steps only (per org), hidden when complete.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { BuilderOnboardingStatus } from '@feasly/contracts';
import { BuilderOnboardingChecklistComponent } from './builder-onboarding-checklist.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderOnboardingApiService } from './builder-onboarding-api.service';
import { BuilderChecklistState, BuilderOnboardingState } from './builder-onboarding.state';
import { BuilderState } from './builder.state';
import { onboardingOf } from './test-helpers/onboarding.fixtures';

async function setup(onboarding: BuilderOnboardingStatus) {
  TestBed.resetTestingModule();
  const api = { getOnboarding: vi.fn(() => of(onboarding)) };
  TestBed.configureTestingModule({
    imports: [BuilderOnboardingChecklistComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderState, BuilderOnboardingState, BuilderChecklistState]),
      { provide: BuilderOnboardingApiService, useValue: api },
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
    ],
  });
  const store = TestBed.inject(Store);
  const fixture = TestBed.createComponent(BuilderOnboardingChecklistComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const step = (id: string) => el.querySelector<HTMLElement>(`[data-step="${id}"]`);
  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { fixture, api, el, store, step, q };
}

describe('BuilderOnboardingChecklistComponent (#722)', () => {
  it('loads the flags and renders all five steps with progress', async () => {
    const { api, el, step, q } = await setup(onboardingOf());
    expect(api.getOnboarding).toHaveBeenCalledTimes(1);
    expect(el.querySelectorAll('[data-step]').length).toBe(5);
    expect(q('onboarding-progress')?.textContent).toContain('2 of 5 done');
    expect(step('profile')?.classList).toContain('checklist__step--done');
    expect(step('team')?.classList).toContain('checklist__step--done');
    expect(step('agreement')?.classList).not.toContain('checklist__step--done');
  });

  it('links each to-do step to its page where one exists', async () => {
    const { q } = await setup(onboardingOf());
    expect(q('onboarding-link-agreement')?.getAttribute('href')).toBe('/builder/agreement');
    expect(q('onboarding-link-payment')?.getAttribute('href')).toBe('/builder/billing');
    // No builder page for the embed yet.
    expect(q('onboarding-link-embed')).toBeNull();
  });

  it('hides admin-only links from members and says who finishes them', async () => {
    const { q } = await setup(onboardingOf({ isAdmin: false }));
    expect(q('onboarding-link-agreement')).not.toBeNull();
    expect(q('onboarding-link-payment')).toBeNull();
    expect(q('onboarding-admin-note')).not.toBeNull();
  });

  it('lets a done step be hidden (persisted per org), never a to-do step', async () => {
    const { q, store, fixture } = await setup(onboardingOf());
    expect(q('onboarding-dismiss-agreement')).toBeNull();
    const dismiss = q('onboarding-dismiss-team')!;
    expect(dismiss.getAttribute('aria-label')).toContain('Invite your team');
    dismiss.click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-step="team"]')).toBeNull();
    expect(store.selectSnapshot(BuilderChecklistState.dismissed)).toEqual({ _: ['team'] });
    // Progress still counts every step.
    expect(q('onboarding-progress')?.textContent).toContain('2 of 5 done');
  });

  it('is hidden once onboarding is complete', async () => {
    const { q } = await setup(
      onboardingOf({
        agreementAccepted: true,
        paymentMethodSet: true,
        embedVerified: true,
        complete: true,
      }),
    );
    expect(q('onboarding-checklist')).toBeNull();
  });
});
