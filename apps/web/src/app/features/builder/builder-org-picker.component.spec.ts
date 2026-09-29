/**
 * Builder org picker component specs (auth/05).
 *
 * - Loads memberships on init via `LoadBuilderMemberships`.
 * - Choosing an org calls `switchOrg`, dispatches `SetBuilderActiveOrg`,
 *   re-probes the session, and routes to `/builder`.
 * - A switch failure shows the error copy and keeps the user on the page.
 * - The empty state explains that no organization was found.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderOrgPickerComponent } from './builder-org-picker.component';
import { BuilderAuthApiService } from './builder-auth-api.service';
import { BuilderState } from './builder.state';
import {
  LoadBuilderMemberships,
  LoadBuilderSession,
  SetBuilderActiveOrg,
} from './builder.actions';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import type { BuilderOrgMembership } from './builder-auth.contracts';

const MEMBERSHIPS: BuilderOrgMembership[] = [
  { builderId: 'b1', builderName: 'Acme Builders', role: 'builder_admin' },
  { builderId: 'b2', builderName: 'Beta Homes', role: 'builder_member' },
];

function setup(opts: {
  memberships?: BuilderOrgMembership[];
  loading?: boolean;
  loadError?: boolean;
  switchOk?: boolean;
}) {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn() };
  const dispatched: unknown[] = [];
  const store = {
    dispatch: vi.fn((action: unknown) => {
      dispatched.push(action);
      return of(null);
    }),
    selectSignal: vi.fn((selector: unknown) => {
      if (selector === BuilderState.memberships) return () => opts.memberships ?? MEMBERSHIPS;
      if (selector === BuilderState.membershipsLoading) return () => opts.loading ?? false;
      if (selector === BuilderState.membershipsError) return () => opts.loadError ?? false;
      return () => undefined;
    }),
  };
  const switchOrg = vi.fn().mockReturnValue(
    opts.switchOk === false
      ? throwError(() => ({ retryable: true }))
      : of({ activeBuilderId: 'b2', activeBuilderName: 'Beta Homes', role: 'builder_member' }),
  );
  const api = { switchOrg };
  const router = { navigate: vi.fn().mockResolvedValue(true) };
  // Builder copy under test: served as the deploy-time override so the
  // component's real provideBuilderCopy() factory merges it over the defaults.
  const builderCopy = {
  orgPickerHeading: 'Choose your organization',
  orgPickerIntro: 'Pick the one you want to work in.',
  orgPickerLoading: 'Loading your organizations…',
  orgPickerError: 'Could not load your organizations.',
  orgPickerRetry: 'Retry',
  orgRoleAdmin: 'Administrator',
  orgRoleMember: 'Member',
  teamActionError: 'Something went wrong. Please try again.',
  };
  const config = {
    get: (section: string) =>
      section === 'copy'
        ? { builder: builderCopy }
        : {},
    getServedBuilderCopy: () => builderCopy,
  };

  TestBed.configureTestingModule({
    imports: [BuilderOrgPickerComponent],
    providers: [
      { provide: Store, useValue: store },
      { provide: Router, useValue: router },
      { provide: BuilderAuthApiService, useValue: api },
      { provide: ConfigService, useValue: config },
      { provide: SeoService, useValue: seo },
    ],
  });
  const fixture: ComponentFixture<BuilderOrgPickerComponent> =
    TestBed.createComponent(BuilderOrgPickerComponent);
  fixture.detectChanges();
  return { fixture, dispatched, switchOrg, router };
}

describe('BuilderOrgPickerComponent (auth/05)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('loads memberships on init', () => {
    const { dispatched } = setup({});
    expect(
      dispatched.some((a) => a instanceof LoadBuilderMemberships),
    ).toBe(true);
  });

  it('lists each organization with its role label', () => {
    const { fixture } = setup({});
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Acme Builders');
    expect(text).toContain('Beta Homes');
    expect(text).toContain('Administrator');
    expect(text).toContain('Member');
  });

  it('choosing an org switches, sets it active, re-probes, and routes to /builder', () => {
    const { fixture, dispatched, switchOrg, router } = setup({});
    const buttons = fixture.nativeElement.querySelectorAll(
      '.builder-org-picker__org',
    ) as NodeListOf<HTMLButtonElement>;
    buttons[1].click();
    expect(switchOrg).toHaveBeenCalledWith({ builderId: 'b2' });
    expect(
      dispatched.some((a) => a instanceof SetBuilderActiveOrg),
    ).toBe(true);
    expect(
      dispatched.some((a) => a instanceof LoadBuilderSession),
    ).toBe(true);
    expect(router.navigate).toHaveBeenCalledWith(['/builder']);
  });

  it('a switch failure shows the error copy and stays on the page', () => {
    const { fixture, router } = setup({ switchOk: false });
    const buttons = fixture.nativeElement.querySelectorAll(
      '.builder-org-picker__org',
    ) as NodeListOf<HTMLButtonElement>;
    buttons[0].click();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Something went wrong. Please try again.');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('shows the loading copy while memberships load', () => {
    const { fixture } = setup({ loading: true, memberships: [] });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Loading your organizations…');
  });

  it('shows the error copy with a retry when loading fails', () => {
    const { fixture, dispatched } = setup({ loadError: true, memberships: [] });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Could not load your organizations.');
    const retry = fixture.nativeElement.querySelector(
      '.builder-login__submit',
    ) as HTMLButtonElement;
    retry.click();
    expect(
      dispatched.filter((a) => a instanceof LoadBuilderMemberships).length,
    ).toBeGreaterThan(1);
  });
});
