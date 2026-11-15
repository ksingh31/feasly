/**
 * Builder shell v2 tests (#502, portal UI kit §4).
 *
 * Top bar: brand + Leads · Money · Team (Money/Team admin-only), account
 * menu whose trigger always shows the current org and whose menu holds the
 * org switcher, email and sign out. Record contract is not a nav item (it
 * lives in the Money sub-nav). Bottom tab bar markup for < 768px. The
 * failed-card danger strip shows for admins while a charge has failed.
 */
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderShellComponent, isMoneyUrl } from './builder-shell.component';
import { BuilderState } from './builder.state';
import { BuilderInvoicesState } from './builder-invoices.state';
import {
  ExitBuilderViewAs,
  LoadBuilderMemberships,
  LogoutBuilder,
} from './builder.actions';
import { LoadActionableInvoices } from './builder-invoices.actions';
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

interface SetupOptions {
  isAdmin?: boolean;
  viewAsBanner?: { displayName: string | null; realEmail: string | null } | null;
  invoices?: readonly { id: string; status: string }[];
  url?: string;
  orgName?: string | null;
}

async function setup(opts: SetupOptions = {}) {
  const { isAdmin = true, viewAsBanner = null, invoices = [], url } = opts;
  const orgName = opts.orgName === undefined ? SESSION.builderName : opts.orgName;
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn(), setForRoute: vi.fn() };
  const configStub = {
    get: (section: keyof typeof DEFAULT_APP_CONFIG) =>
      DEFAULT_APP_CONFIG[section],
    getServedBuilderCopy: () => null,
  } as unknown as ConfigService;

  const store = {
    dispatch: vi.fn().mockReturnValue(of({})),
    selectSignal: (selector: unknown) => {
      if (selector === BuilderState.session) return signal(SESSION);
      if (selector === BuilderState.activeBuilderName)
        return signal(orgName);
      if (selector === BuilderState.isBuilderAdmin) return signal(isAdmin);
      if (selector === BuilderState.viewAsBanner) return signal(viewAsBanner);
      if (selector === BuilderInvoicesState.actionableInvoices)
        return signal(invoices);
      if (selector === BuilderInvoicesState.actionableStatus)
        return signal('ready');
      return signal(null);
    },
  };

  TestBed.configureTestingModule({
    imports: [BuilderShellComponent, BlankComponent],
    providers: [
      provideRouter([
        { path: 'builder', component: BlankComponent },
        { path: 'builder/billing', component: BlankComponent },
        { path: 'builder/invoices', component: BlankComponent },
        { path: 'builder/team', component: BlankComponent },
        { path: 'builder/org-picker', component: BlankComponent },
        { path: 'builder/record-contract', component: BlankComponent },
        { path: '**', component: BlankComponent },
      ]),
      { provide: SeoService, useValue: seo },
      { provide: Store, useValue: store },
      { provide: ConfigService, useValue: configStub },
    ],
  });
  if (url) {
    await TestBed.inject(Router).navigateByUrl(url);
  }
  const fixture: ComponentFixture<BuilderShellComponent> =
    TestBed.createComponent(BuilderShellComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, store, seo };
}

function q<T extends Element = HTMLElement>(
  fixture: ComponentFixture<BuilderShellComponent>,
  selector: string,
): T | null {
  return fixture.nativeElement.querySelector(selector) as T | null;
}

function hrefsIn(
  fixture: ComponentFixture<BuilderShellComponent>,
  selector: string,
): (string | null)[] {
  return Array.from(
    fixture.nativeElement.querySelectorAll(`${selector} a`) as NodeListOf<HTMLAnchorElement>,
  ).map((a) => a.getAttribute('href'));
}

function trigger(fixture: ComponentFixture<BuilderShellComponent>): HTMLButtonElement {
  const el = q<HTMLButtonElement>(fixture, '.builder-shell__account-trigger');
  if (!el) throw new Error('account trigger not found');
  return el;
}

async function openAccount(fixture: ComponentFixture<BuilderShellComponent>) {
  trigger(fixture).click();
  fixture.detectChanges();
  await fixture.whenStable();
}

describe('isMoneyUrl', () => {
  it.each([
    ['/builder/invoices', true],
    ['/builder/invoices?invoice=abc', true],
    ['/builder/billing', true],
    ['/builder/record-contract', true],
    ['/builder', false],
    ['/builder/team', false],
    ['/builder/invoicesx', false],
  ])('%s → %s', (url, expected) => {
    expect(isMoneyUrl(url)).toBe(expected);
  });
});

describe('BuilderShellComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows the brand mark, wordmark, and home link', async () => {
    const { fixture } = await setup();
    const brand = q<HTMLAnchorElement>(fixture, '.builder-shell__brand');
    expect(brand).not.toBeNull();
    expect(brand!.querySelector('app-brand-mark')).not.toBeNull();
    expect(brand!.querySelector('.builder-shell__wordmark')?.textContent).toContain(
      'Feasly Builder',
    );
    expect(brand!.getAttribute('aria-label')).toContain('Feasly Builder home');
    expect(brand!.getAttribute('href')).toBe('/builder');
  });

  it('renders Leads · Money · Team for admins, and no Record contract nav item', async () => {
    const { fixture } = await setup();
    const nav = q(fixture, '.builder-shell__nav')!;
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(labels).toEqual(['Leads', 'Money', 'Team']);
    expect(hrefsIn(fixture, '.builder-shell__nav')).toEqual([
      '/builder',
      '/builder/invoices',
      '/builder/team',
    ]);
    // Record contract is an action, not a nav item.
    expect(hrefsIn(fixture, '.builder-shell__nav')).not.toContain('/builder/record-contract');
    expect(hrefsIn(fixture, '.builder-shell__tabs')).not.toContain('/builder/record-contract');
  });

  it('renders the bottom tab bar with the same sections', async () => {
    const { fixture } = await setup();
    const tabs = q(fixture, 'nav.builder-shell__tabs');
    expect(tabs).not.toBeNull();
    expect(tabs!.getAttribute('aria-label')).toBe('Builder portal sections');
    expect(hrefsIn(fixture, '.builder-shell__tabs')).toEqual([
      '/builder',
      '/builder/invoices',
      '/builder/team',
    ]);
  });

  it('hides Money and Team from members everywhere (AC3)', async () => {
    const { fixture } = await setup({ isAdmin: false });
    for (const sel of ['.builder-shell__nav', '.builder-shell__tabs']) {
      const hrefs = hrefsIn(fixture, sel);
      expect(hrefs).toEqual(['/builder']);
    }
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Money');
    expect(text).not.toContain('Team');
  });

  it('does not load the actionable invoices for members', async () => {
    const { store } = await setup({ isAdmin: false });
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.any(LoadActionableInvoices));
  });

  it('loads the actionable invoices for admins (danger strip data)', async () => {
    const { store } = await setup();
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(LoadActionableInvoices));
  });

  it('always shows the current org on the account trigger (AC1)', async () => {
    const { fixture } = await setup();
    const btn = trigger(fixture);
    expect(btn.textContent).toContain('Acme Builds');
    expect(btn.getAttribute('aria-label')).toContain('Acme Builds');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(q(fixture, '#builder-account-menu')).toBeNull();
  });

  it('loads memberships to resolve the org name when the session lacks it', async () => {
    const { store } = await setup({ orgName: null });
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(LoadBuilderMemberships));
  });

  it('does not reload memberships when the org name is known', async () => {
    const { store } = await setup();
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.any(LoadBuilderMemberships));
  });

  it('opens the account menu with org switcher, email and sign out', async () => {
    const { fixture } = await setup();
    await openAccount(fixture);
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('true');
    const menu = q(fixture, '#builder-account-menu')!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain('Acme Builds');
    expect(menu.textContent).toContain('builder@example.com');
    const switcher = menu.querySelector('.builder-shell__switch-org') as HTMLAnchorElement;
    expect(switcher.getAttribute('href')).toBe('/builder/org-picker');
    expect(switcher.textContent).toContain('Switch organization');
    expect(menu.querySelector('.builder-shell__sign-out')?.textContent).toContain('Sign out');
  });

  it('closes the account menu on Escape and returns focus to the trigger', async () => {
    const { fixture } = await setup();
    await openAccount(fixture);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(q(fixture, '#builder-account-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger(fixture));
  });

  it('closes the account menu on an outside click', async () => {
    const { fixture } = await setup();
    await openAccount(fixture);
    document.body.click();
    fixture.detectChanges();
    expect(q(fixture, '#builder-account-menu')).toBeNull();
  });

  it('closes the account menu when navigation completes', async () => {
    const { fixture } = await setup();
    await openAccount(fixture);
    await TestBed.inject(Router).navigateByUrl('/builder/team');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(q(fixture, '#builder-account-menu')).toBeNull();
  });

  it('dispatches LogoutBuilder on sign out', async () => {
    const { fixture, store } = await setup();
    await openAccount(fixture);
    q<HTMLButtonElement>(fixture, '.builder-shell__sign-out')!.click();
    await fixture.whenStable();
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(LogoutBuilder));
  });

  it('marks Money active and shows the Money sub-nav (with Record contract) on Money routes', async () => {
    const { fixture } = await setup({ url: '/builder/billing' });
    const money = q<HTMLAnchorElement>(fixture, '.builder-shell__nav a[href="/builder/invoices"]')!;
    expect(money.classList.contains('active')).toBe(true);
    expect(money.getAttribute('aria-current')).toBe('page');
    expect(hrefsIn(fixture, '.builder-shell__subnav')).toEqual([
      '/builder/invoices',
      '/builder/billing',
      '/builder/record-contract',
    ]);
  });

  it('hides the Money sub-nav outside Money routes', async () => {
    const { fixture } = await setup({ url: '/builder' });
    expect(q(fixture, '.builder-shell__subnav')).toBeNull();
  });

  it('shows the failed-card danger strip for admins while a charge has failed', async () => {
    const { fixture } = await setup({
      invoices: [
        { id: 'i1', status: 'in_review' },
        { id: 'i2', status: 'failed' },
      ],
    });
    const strip = q(fixture, '.builder-shell__danger')!;
    expect(strip).not.toBeNull();
    expect(strip.getAttribute('role')).toBe('alert');
    expect(strip.querySelector('a')?.getAttribute('href')).toBe('/builder/billing');
  });

  it('hides the danger strip with no failed charge', async () => {
    const { fixture } = await setup({ invoices: [{ id: 'i1', status: 'in_review' }] });
    expect(q(fixture, '.builder-shell__danger')).toBeNull();
  });

  it('hides the danger strip from members', async () => {
    const { fixture } = await setup({
      isAdmin: false,
      invoices: [{ id: 'i2', status: 'failed' }],
    });
    expect(q(fixture, '.builder-shell__danger')).toBeNull();
  });

  it('hides the view-as banner when the session is not viewing-as', async () => {
    const { fixture } = await setup();
    expect(q(fixture, '.view-as-banner')).toBeNull();
  });

  it('shows the shared view-as banner while viewing-as', async () => {
    const { fixture } = await setup({
      viewAsBanner: { displayName: 'Team Member', realEmail: 'admin@builder.com' },
    });
    const banner = q(fixture, '.view-as-banner')!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Viewing as');
    expect(banner.textContent).toContain('Team Member');
    expect(banner.textContent).toContain('admin@builder.com');
  });

  it('dispatches ExitBuilderViewAs when the banner exit is clicked', async () => {
    const { fixture, store } = await setup({
      viewAsBanner: { displayName: 'Team Member', realEmail: 'admin@builder.com' },
    });
    q<HTMLButtonElement>(fixture, '.view-as-banner__exit')!.click();
    await fixture.whenStable();
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(ExitBuilderViewAs));
  });
});
