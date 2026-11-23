/**
 * Admin shell (#503) component tests.
 *
 * Covers: grouped sidebar + permission gating, active state, off-canvas
 * menu (toggle, scrim, Esc, focus in/out), sidebar keyboard navigation,
 * collapsible rail, breadcrumbs, queue badges, the ⌘K / `/` command palette
 * (#538), the user menu, and the admin error boundary (an admin failure renders inside the
 * shell, not on the public /error page).
 */
import { InteractivityChecker } from '@angular/cdk/a11y';
import { Component, ErrorHandler, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalErrorHandler } from '../../core/errors/global-error.handler';
import { SeoService } from '../../core/seo/seo.service';
import { LoadAdminDisputes } from './admin-disputes.actions';
import { AdminDisputesState } from './admin-disputes.state';
import { RefreshQuarantineCount } from './admin-quarantine.actions';
import { AdminQuarantineState } from './admin-quarantine.state';
import { AdminAuthState } from './admin-auth.state';
import { LogoutAdmin } from './admin-auth.actions';
import { AdminErrorComponent } from './admin-error.component';
import { AdminShellComponent } from './admin-shell.component';
import { AdminEntraAuthService } from './admin-entra-auth.service';
import { AdminSearchState } from './admin-search.state';

@Component({ standalone: true, template: '<p class="blank-page">page</p>' })
class BlankComponent {}

interface StoreSignals {
  permissions: WritableSignal<string[] | null>;
  disputes: WritableSignal<unknown[]>;
  quarantine: WritableSignal<number | null>;
  email: WritableSignal<string | null>;
  name: WritableSignal<string | null>;
}

function makeStore(
  overrides: Partial<{ permissions: string[]; disputes: unknown[]; quarantine: number | null }> = {},
) {
  const signals: StoreSignals = {
    permissions: signal(overrides.permissions ?? ['billing:read']),
    disputes: signal(overrides.disputes ?? []),
    quarantine: signal(overrides.quarantine ?? null),
    email: signal('ops@example.com'),
    name: signal('Riley Ops'),
  };
  const bySelector = new Map<unknown, WritableSignal<unknown>>([
    [AdminAuthState.permissions, signals.permissions],
    [AdminAuthState.email, signals.email],
    [AdminAuthState.name, signals.name],
    [AdminDisputesState.disputes, signals.disputes],
    [AdminQuarantineState.queueCount, signals.quarantine],
    [AdminSearchState.palette, signal({ query: '', hits: [], status: 'idle', error: null })],
  ]);
  const store = {
    dispatch: vi.fn().mockReturnValue(of({})),
    selectSignal: vi.fn((selector: unknown) => bySelector.get(selector) ?? signal(null)),
  };
  return { store, signals };
}

async function setup(
  opts: { permissions?: string[]; disputes?: unknown[]; quarantine?: number | null; url?: string } = {},
) {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn(), setForRoute: vi.fn() };
  const { store, signals } = makeStore(opts);
  TestBed.configureTestingModule({
    imports: [AdminShellComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '**', component: BlankComponent }]),
      { provide: SeoService, useValue: seo },
      { provide: Store, useValue: store },
      { provide: AdminEntraAuthService, useValue: { consumeSignOutRedirect: () => false } },
      // jsdom has no layout: let the CDK focus trap treat elements as tabbable.
      {
        provide: InteractivityChecker,
        useValue: {
          isFocusable: (el: HTMLElement) => el.tabIndex >= 0,
          isTabbable: (el: HTMLElement) => el.tabIndex >= 0,
          isVisible: () => true,
          isDisabled: (el: HTMLElement) => !!(el as HTMLButtonElement).disabled,
        },
      },
    ],
  });
  const router = TestBed.inject(Router);
  if (opts.url) await router.navigateByUrl(opts.url);
  const fixture: ComponentFixture<AdminShellComponent> =
    TestBed.createComponent(AdminShellComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, seo, store, signals, router };
}

const q = <T extends Element = HTMLElement>(f: ComponentFixture<unknown>, sel: string): T => {
  const el = (f.nativeElement as HTMLElement).querySelector<T>(sel);
  if (!el) throw new Error(`${sel} not found`);
  return el;
};
const qa = (f: ComponentFixture<unknown>, sel: string): HTMLElement[] =>
  Array.from((f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(sel));
const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** Polls a condition with a deadline (no fixed sleeps). */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AdminShellComponent — sidebar', () => {
  it('groups the nav into Pipeline, Partners, Money, System with every section', async () => {
    const { fixture } = await setup({ permissions: ['billing:read', 'api_keys:manage'] });
    expect(qa(fixture, '.admin-nav__group-label').map(text)).toEqual([
      'Pipeline',
      'Partners',
      'Money',
      'System',
    ]);
    expect(qa(fixture, '.admin-nav__link').map((a) => a.getAttribute('href'))).toEqual([
      '/admin/leads',
      '/admin/quarantine',
      '/admin/estimates',
      '/admin/builders',
      '/admin/users',
      '/admin/api-keys',
      '/admin/billing',
      '/admin/billing/invoices',
      '/admin/disputes',
      '/admin/calibration',
      '/admin/ops/sheets',
      '/admin/ops/community-narratives',
      '/admin/funnels',
      '/admin/webhooks',
    ]);
    expect(qa(fixture, '.admin-nav__label').map(text)).toContain('Users & access');
  });

  it('hides API keys from sessions without api_keys:manage', async () => {
    const { fixture } = await setup({ permissions: ['billing:read'] });
    expect(fixture.nativeElement.querySelector('a[href="/admin/api-keys"]')).toBeNull();
  });

  it('marks only the owning section active (Invoices, not Billing overview)', async () => {
    const { fixture } = await setup({ url: '/admin/billing/invoices/inv-1' });
    const active = qa(fixture, '.admin-nav__link--active');
    expect(active.map((a) => a.getAttribute('href'))).toEqual(['/admin/billing/invoices']);
    expect(active[0].getAttribute('aria-current')).toBe('page');
  });

  it('shows the open-disputes queue badge and prefetches it with billing:read', async () => {
    const { fixture, store } = await setup({ disputes: [{ id: 'd1' }, { id: 'd2' }] });
    const badge = q(fixture, 'a[href="/admin/disputes"] .admin-nav__badge');
    expect(text(badge)).toBe('2 open');
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(LoadAdminDisputes));
    // Other items carry no badge.
    expect(qa(fixture, '.admin-nav__badge')).toHaveLength(1);
  });

  it('shows the quarantine queue badge and refreshes its count on load', async () => {
    const { fixture, store } = await setup({ permissions: [], quarantine: 3 });
    const badge = q(fixture, 'a[href="/admin/quarantine"] .admin-nav__badge');
    expect(text(badge)).toBe('3 open');
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(RefreshQuarantineCount));
  });

  it('does not prefetch the disputes queue without billing:read', async () => {
    const { fixture, store } = await setup({ permissions: [] });
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.any(LoadAdminDisputes));
    expect(qa(fixture, '.admin-nav__badge')).toHaveLength(0);
  });

  it('moves focus between links with Arrow keys, Home and End', async () => {
    const { fixture } = await setup();
    const links = qa(fixture, '.admin-nav__link');
    links[0].focus();
    keydown(links[0], 'ArrowDown');
    expect(document.activeElement).toBe(links[1]);
    keydown(links[1], 'ArrowUp');
    expect(document.activeElement).toBe(links[0]);
    keydown(links[0], 'ArrowUp');
    expect(document.activeElement).toBe(links[links.length - 1]);
    keydown(document.activeElement as HTMLElement, 'Home');
    expect(document.activeElement).toBe(links[0]);
    keydown(links[0], 'End');
    expect(document.activeElement).toBe(links[links.length - 1]);
  });

  it('collapses to the rail and back, keeping labels as tooltips', async () => {
    const { fixture } = await setup();
    const toggle = q<HTMLButtonElement>(fixture, '.admin-topbar__collapse-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');

    toggle.click();
    fixture.detectChanges();
    expect(q(fixture, '.admin-shell').classList).toContain('admin-shell--collapsed');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(q(fixture, '.admin-nav__link[href="/admin/leads"]').getAttribute('title')).toBe('Leads');

    toggle.click();
    fixture.detectChanges();
    expect(q(fixture, '.admin-shell').classList).not.toContain('admin-shell--collapsed');
    expect(q(fixture, '.admin-nav__link[href="/admin/leads"]').getAttribute('title')).toBeNull();
  });
});

describe('AdminShellComponent — mobile off-canvas', () => {
  it('opens with focus on the first link and closes on Esc with focus back on the toggle', async () => {
    const { fixture } = await setup();
    const toggle = q<HTMLButtonElement>(fixture, '.admin-topbar__menu-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('admin-sidebar');

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Close menu');
    expect(q(fixture, '.admin-shell').classList).toContain('admin-shell--menu-open');
    const first = q(fixture, '.admin-nav__link');
    await waitFor(() => document.activeElement === first, 'focus on first link');

    keydown(document, 'Escape');
    fixture.detectChanges();
    expect(q(fixture, '.admin-shell').classList).not.toContain('admin-shell--menu-open');
    expect(document.activeElement).toBe(toggle);
  });

  it('closes when the scrim is clicked', async () => {
    const { fixture } = await setup();
    q<HTMLButtonElement>(fixture, '.admin-topbar__menu-toggle').click();
    fixture.detectChanges();
    q(fixture, '.admin-shell__scrim').click();
    fixture.detectChanges();
    expect(q(fixture, '.admin-shell').classList).not.toContain('admin-shell--menu-open');
  });

  it('closes when a nav link is followed', async () => {
    const { fixture } = await setup();
    q<HTMLButtonElement>(fixture, '.admin-topbar__menu-toggle').click();
    fixture.detectChanges();
    q(fixture, 'a[href="/admin/builders"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q(fixture, '.admin-shell').classList).not.toContain('admin-shell--menu-open');
  });
});

describe('AdminShellComponent — top bar', () => {
  it('shows group › section breadcrumbs for the current page', async () => {
    const { fixture, router } = await setup({ url: '/admin/billing/invoices/inv-1' });
    expect(qa(fixture, '.admin-topbar__crumbs li').map(text)).toEqual(['Money', 'Invoices']);
    expect(q(fixture, '.admin-topbar__crumbs a').getAttribute('href')).toBe('/admin/billing/invoices');
    await router.navigateByUrl('/admin/error');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.admin-topbar__crumbs ol')).toBeNull();
  });

  const palette = (): HTMLElement | null => document.querySelector('app-admin-command-palette');
  const paletteInput = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('.admin-palette__input');

  it('⌘K / Ctrl+K toggles the command palette with focus in its search box (#538)', async () => {
    const { fixture } = await setup();
    const event = keydown(document, 'k', { metaKey: true });
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => palette() !== null, 'palette open');
    await waitFor(() => document.activeElement === paletteInput(), 'focus in palette');
    expect(q(fixture, '.admin-topbar__search-button').getAttribute('aria-expanded')).toBe('true');

    keydown(document, 'k', { metaKey: true });
    fixture.detectChanges();
    await waitFor(() => palette() === null, 'palette closed');

    keydown(document, 'K', { ctrlKey: true });
    fixture.detectChanges();
    await waitFor(() => palette() !== null, 'palette reopened via Ctrl+K');
  });

  it('Esc closes the palette and returns focus to the trigger', async () => {
    const { fixture } = await setup();
    const trigger = q<HTMLButtonElement>(fixture, '.admin-topbar__search-button');
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await waitFor(() => document.activeElement === paletteInput(), 'focus in palette');
    keydown(paletteInput()!, 'Escape', { keyCode: 27 });
    fixture.detectChanges();
    await waitFor(() => palette() === null, 'palette closed');
    await waitFor(() => document.activeElement === trigger, 'focus back on trigger');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('/ opens the palette, but not while typing in a field', async () => {
    const { fixture } = await setup();
    const field = document.createElement('input');
    document.body.appendChild(field);
    const typed = keydown(field, '/');
    fixture.detectChanges();
    expect(typed.defaultPrevented).toBe(false);
    expect(palette()).toBeNull();

    const event = keydown(document.body, '/');
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => palette() !== null, 'palette open via /');
  });

  it('/ leaves page search to a FilterBar when the page has one', async () => {
    const { fixture } = await setup();
    q(fixture, '#admin-main').appendChild(document.createElement('ui-filter-bar'));
    const event = keydown(document.body, '/');
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(false);
    expect(palette()).toBeNull();
  });

  it('opens the user menu with identity + sign out; Esc closes and refocuses', async () => {
    const { fixture, store, router } = await setup();
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const trigger = q<HTMLButtonElement>(fixture, '.admin-topbar__avatar');
    expect(text(trigger)).toBe('R');
    trigger.click();
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(text(q(fixture, '#admin-user-menu'))).toContain('ops@example.com');

    keydown(document, 'Escape');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#admin-user-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    fixture.detectChanges();
    q<HTMLButtonElement>(fixture, '.admin-topbar__menu-item').click();
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(LogoutAdmin));
    expect(navigate).toHaveBeenCalledWith(['/admin/login']);
  });

  it('closes the user menu on an outside click', async () => {
    const { fixture } = await setup();
    q<HTMLButtonElement>(fixture, '.admin-topbar__avatar').click();
    fixture.detectChanges();
    q(fixture, '.admin-shell__main').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#admin-user-menu')).toBeNull();
  });

  it('drives the document title from the seo-routes table on navigation', async () => {
    const { fixture, seo, router } = await setup();
    await router.navigateByUrl('/admin/billing');
    await fixture.whenStable();
    expect(seo.setForRoute).toHaveBeenCalledWith('/admin/billing');
  });
});

describe('AdminShellComponent — error boundary', () => {
  it('renders an admin route failure inside the shell, sidebar intact', async () => {
    TestBed.resetTestingModule();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store } = makeStore();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'admin',
            component: AdminShellComponent,
            children: [
              { path: 'error', component: AdminErrorComponent },
              { path: '**', component: BlankComponent },
            ],
          },
          { path: 'error', component: BlankComponent },
        ]),
        { provide: ErrorHandler, useClass: GlobalErrorHandler },
        { provide: SeoService, useValue: { setPage: vi.fn(), setForRoute: vi.fn() } },
        { provide: Store, useValue: store },
        { provide: AdminEntraAuthService, useValue: { consumeSignOutRedirect: () => false } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/admin/disputes');
    const router = TestBed.inject(Router);

    TestBed.inject(ErrorHandler).handleError(new Error('boom'));
    await waitFor(() => router.url === '/admin/error', 'admin error route');
    harness.detectChanges();

    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('.admin-sidebar')).not.toBeNull();
    expect(root.querySelector('app-admin-error [role="alert"]')).not.toBeNull();
    expect(router.url).not.toBe('/error');
  });
});
