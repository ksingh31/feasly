/**
 * Builder shell component tests.
 *
 * Mirrors admin-shell.component.spec.ts: the header carries the brand mark
 * and "Feasly Builder" wordmark, the mobile menu toggle opens/closes the
 * nav (with aria-expanded), the menu closes when a nav link is clicked or
 * navigation completes, all builder nav links render with correct
 * routerLinks, the Team link is admin-only, and sign-out dispatches
 * LogoutBuilder.
 */
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderShellComponent } from './builder-shell.component';
import { BuilderState } from './builder.state';
import { LogoutBuilder, ExitBuilderViewAs } from './builder.actions';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import type { BuilderSessionIdentity } from './builder-auth.contracts';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

const SESSION: BuilderSessionIdentity = {
  authenticated: true,
  email: 'builder@example.com',
  name: 'Builder User',
  builderId: 'org-1',
  builderName: 'Acme Builds',
  role: 'builder_admin',
  memberships: [],
  viewAs: null,
  viewAsDisplayName: null,
  realEmail: null,
};

/**
 * Sets up the shell with a mock store. `isAdmin` toggles the
 * isBuilderAdmin selector so admin-only links can be covered both ways.
 */
async function setup(
  isAdmin = true,
  viewAsBanner: { displayName: string | null; realEmail: string | null } | null = null,
) {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn(), setForRoute: vi.fn() };
  const configStub = {
    get: (section: keyof typeof DEFAULT_APP_CONFIG) =>
      DEFAULT_APP_CONFIG[section],
    // Served app-config.json had no copy.builder overrides in this test.
    getServedBuilderCopy: () => null,
  } as unknown as ConfigService;

  const store = {
    dispatch: vi.fn().mockReturnValue(of({})),
    selectSignal: (selector: unknown) => {
      if (selector === BuilderState.session) return signal(SESSION);
      if (selector === BuilderState.activeBuilderName)
        return signal(SESSION.builderName);
      if (selector === BuilderState.isBuilderAdmin) return signal(isAdmin);
      // Builder-side view-as banner (2026-09-30, Karan).
      if (selector === BuilderState.viewAsBanner) return signal(viewAsBanner);
      return signal(null);
    },
  };

  TestBed.configureTestingModule({
    imports: [BuilderShellComponent, BlankComponent],
    providers: [
      provideRouter([
        { path: 'builder', component: BlankComponent },
        { path: 'builder/billing', component: BlankComponent },
        { path: 'builder/team', component: BlankComponent },
        { path: 'builder/org-picker', component: BlankComponent },
        { path: 'builder/report-contract', component: BlankComponent },
        { path: '**', component: BlankComponent },
      ]),
      { provide: SeoService, useValue: seo },
      { provide: Store, useValue: store },
      { provide: ConfigService, useValue: configStub },
    ],
  });
  const fixture: ComponentFixture<BuilderShellComponent> =
    TestBed.createComponent(BuilderShellComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, store, seo };
}

function toggleButton(fixture: ComponentFixture<BuilderShellComponent>): HTMLButtonElement {
  const el = fixture.nativeElement.querySelector('.builder-shell__menu-toggle');
  if (!el) throw new Error('menu toggle button not found');
  return el as HTMLButtonElement;
}

function nav(fixture: ComponentFixture<BuilderShellComponent>): HTMLElement {
  const el = fixture.nativeElement.querySelector('.builder-shell__nav');
  if (!el) throw new Error('builder nav not found');
  return el as HTMLElement;
}

describe('BuilderShellComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows the brand mark, wordmark, and home link', async () => {
    const { fixture } = await setup();
    const brand = fixture.nativeElement.querySelector(
      '.builder-shell__brand',
    ) as HTMLAnchorElement;
    expect(brand).not.toBeNull();
    expect(brand.querySelector('app-brand-mark')).not.toBeNull();
    expect(
      brand.querySelector('.builder-shell__wordmark')?.textContent,
    ).toContain('Feasly Builder');
    expect(brand.getAttribute('aria-label')).toContain('Feasly Builder home');
    expect(brand.getAttribute('href')).toBe('/builder');
  });

  it('toggles the mobile nav open and closed', async () => {
    const { fixture } = await setup();
    const button = toggleButton(fixture);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('builder-nav');
    expect(nav(fixture).classList.contains('builder-shell__nav--open')).toBe(
      false,
    );

    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(nav(fixture).classList.contains('builder-shell__nav--open')).toBe(
      true,
    );
    expect(button.textContent).toContain('Close menu');

    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(nav(fixture).classList.contains('builder-shell__nav--open')).toBe(
      false,
    );
    expect(button.textContent).toContain('Open menu');
  });

  it('closes the menu when a nav link is clicked', async () => {
    const { fixture } = await setup();
    toggleButton(fixture).click();
    fixture.detectChanges();
    expect(nav(fixture).classList.contains('builder-shell__nav--open')).toBe(
      true,
    );

    const link = fixture.nativeElement.querySelector(
      '.builder-shell__nav a',
    ) as HTMLAnchorElement;
    link.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(nav(fixture).classList.contains('builder-shell__nav--open')).toBe(
      false,
    );
  });

  it('closes the menu when navigation completes', async () => {
    const { fixture } = await setup();
    toggleButton(fixture).click();
    fixture.detectChanges();
    expect(nav(fixture).classList.contains('builder-shell__nav--open')).toBe(
      true,
    );

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/builder/billing');
    await fixture.whenStable();
    expect(nav(fixture).classList.contains('builder-shell__nav--open')).toBe(
      false,
    );
  });

  it('renders every nav link with the correct routerLink', async () => {
    const { fixture } = await setup();
    const hrefs = fixture.debugElement
      .queryAll(By.directive(RouterLink))
      .filter((d) => (d.nativeElement as HTMLElement).tagName === 'A')
      .map((d) => (d.nativeElement as HTMLAnchorElement).getAttribute('href'));
    for (const expected of [
      '/builder',
      '/builder/invoices',
      '/builder/record-contract',
      '/builder/billing',
      '/builder/team',
      '/builder/org-picker',
    ]) {
      expect(hrefs).toContain(expected);
    }
  });

  it('shows the org switcher link with the active org name and aria label', async () => {
    const { fixture } = await setup();
    const org = fixture.nativeElement.querySelector(
      '.builder-shell__org',
    ) as HTMLAnchorElement;
    expect(org).not.toBeNull();
    expect(org.textContent).toContain('Acme Builds');
    expect(org.getAttribute('aria-label')).toContain('Acme Builds');
    expect(org.getAttribute('href')).toBe('/builder/org-picker');
  });

  it('shows the signed-in session email', async () => {
    const { fixture } = await setup();
    expect(
      fixture.nativeElement.querySelector('.builder-shell__email')
        ?.textContent,
    ).toContain('builder@example.com');
  });

  it('hides the Team link for non-admins', async () => {
    const { fixture } = await setup(false);
    const teamLink = fixture.debugElement
      .queryAll(By.directive(RouterLink))
      .find((d) => {
        const el = d.nativeElement as HTMLAnchorElement;
        return el.getAttribute('href') === '/builder/team';
      });
    expect(teamLink).toBeUndefined();
  });

  it('hides the billing surfaces for non-admins (QA 2026-10-04)', async () => {
    // Billing, Invoices, and Record contract are admin-only backend-side
    // (builder:billing); members must not see them — no 403 retry loops.
    const { fixture } = await setup(false);
    const hrefs = fixture.debugElement
      .queryAll(By.directive(RouterLink))
      .filter((d) => (d.nativeElement as HTMLElement).tagName === 'A')
      .map((d) => (d.nativeElement as HTMLAnchorElement).getAttribute('href'));
    for (const hidden of ['/builder/billing', '/builder/invoices', '/builder/record-contract']) {
      expect(hrefs).not.toContain(hidden);
    }
    // Dashboard and org switcher stay visible to members.
    expect(hrefs).toContain('/builder');
    expect(hrefs).toContain('/builder/org-picker');
  });

  it('dispatches LogoutBuilder on sign out', async () => {
    const { fixture, store } = await setup();
    const signOut = fixture.nativeElement.querySelector(
      '.builder-shell__nav button',
    ) as HTMLButtonElement;
    expect(signOut.textContent).toContain('Sign out');
    signOut.click();
    await fixture.whenStable();
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(LogoutBuilder));
  });

  it('hides the view-as banner when the session is not viewing-as', async () => {
    const { fixture } = await setup();
    expect(
      fixture.nativeElement.querySelector('.view-as-banner'),
    ).toBeNull();
  });

  it('shows the shared view-as banner while viewing-as', async () => {
    const { fixture } = await setup(true, {
      displayName: 'Team Member',
      realEmail: 'admin@builder.com',
    });
    const banner = fixture.nativeElement.querySelector('.view-as-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Viewing as');
    expect(banner.textContent).toContain('Team Member');
    expect(banner.textContent).toContain('admin@builder.com');
  });

  it('dispatches ExitBuilderViewAs when the banner exit is clicked', async () => {
    const { fixture, store } = await setup(true, {
      displayName: 'Team Member',
      realEmail: 'admin@builder.com',
    });
    const exit = fixture.nativeElement.querySelector(
      '.view-as-banner__exit',
    ) as HTMLButtonElement;
    expect(exit).not.toBeNull();
    exit.click();
    await fixture.whenStable();
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(ExitBuilderViewAs));
  });
});
