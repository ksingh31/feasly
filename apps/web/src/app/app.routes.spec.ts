/**
 * App routes regression specs — admin magic-link retirement (2026-09-28, Karan).
 *
 * The legacy `/admin/verify` sign-in route is retired: Microsoft Entra
 * email+password is the only admin sign-in. Dead magic-link URLs must fall
 * through to the branded wildcard 404 (NotFoundPageComponent), not resolve
 * to a verify page and not redirect to login.
 */
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  provideRouter,
  Router,
  RouterOutlet,
  type RouterStateSnapshot,
  type Routes,
} from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './app.routes';
import { NotFoundPageComponent } from './features/not-found/not-found-page.component';
import { SeoService } from './core/seo/seo.service';

/** Host with a router outlet so navigation activates real route components. */
@Component({ standalone: true, imports: [RouterOutlet], template: '<router-outlet />' })
class HostComponent {}

async function navigateTo(url: string): Promise<Router> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      {
        provide: SeoService,
        useValue: { setForRoute: vi.fn(), setPage: vi.fn() },
      },
    ],
  });
  const host = TestBed.createComponent(HostComponent);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  host.detectChanges();
  await host.whenStable();
  return router;
}

describe('retired /admin/verify route', () => {  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('is not registered in the route table', () => {
    expect(routes.some((r) => r.path === 'admin/verify')).toBe(false);
  });

  it('renders the branded 404 page for the retired magic-link URL', async () => {
    const router = await navigateTo('/admin/verify');
    // The URL is preserved (no redirect to login).
    expect(router.url).toBe('/admin/verify');
    // The only matching route is the '**' wildcard → NotFoundPageComponent.
    const primary = router.routerState.root.firstChild;
    expect(primary?.routeConfig?.component).toBe(NotFoundPageComponent);
  });

  it('keeps the Entra login and callback routes registered', () => {
    const paths = routes.map((r) => r.path);
    expect(paths).toContain('admin/login');
    expect(paths).toContain('admin/auth/callback');
  });
});

/**
 * Wizard deep-link guards (W3, 2026-09-28).
 *
 * Every wizard step that needs a selected property must bounce property-less
 * deep links to the address step instead of rendering a dead-end page.
 */
describe('wizard deep-link guards', () => {
  it("guards 'estimate/details' with the property guard", async () => {
    const mod = await import('./features/wizard/wizard-property.guard');
    const route = routes.find((r) => r.path === 'estimate/details');
    expect(route).toBeDefined();
    expect(route?.canActivate).toContain(mod.wizardPropertyGuard);
  });

  it("guards 'estimate/scope' and 'estimate/preview' with the property guard", async () => {
    const mod = await import('./features/wizard/wizard-property.guard');
    for (const path of ['estimate/scope', 'estimate/preview']) {
      const route = routes.find((r) => r.path === path);
      expect(route?.canActivate).toContain(mod.wizardPropertyGuard);
    }
  });
});

/**
 * #472: the invoice detail page reuses the billing page's manage modal,
 * which reads BillingHealthState. The state is lazy-registered per route,
 * so every route rendering the modal must carry billingHealthStateProvider
 * — otherwise opening Manage threw and crashed out of the admin shell.
 * These tests run the route's real canActivate guards (the lazyProviders)
 * against a root store WITHOUT the state, mirroring production.
 */
describe('admin billing routes register BillingHealthState', () => {
  function adminChildren(): Routes {
    const admin = routes.find((r) => r.path === 'admin');
    expect(admin?.children).toBeDefined();
    return admin?.children ?? [];
  }

  async function activate(path: string): Promise<Store> {
    TestBed.resetTestingModule();
    const { AdminBillingApiService } = await import(
      './features/admin/admin-billing-api.service'
    );
    const { BuilderInvoicesApiService } = await import(
      './features/builder/builder-invoices-api.service'
    );
    TestBed.configureTestingModule({
      providers: [
        provideStore([]),
        { provide: AdminBillingApiService, useValue: {} },
        { provide: BuilderInvoicesApiService, useValue: {} },
      ],
    });
    const route = adminChildren().find((r) => r.path === path);
    expect(route).toBeDefined();
    const guards = (route?.canActivate ?? []) as CanActivateFn[];
    for (const guard of guards) {
      const result = await TestBed.runInInjectionContext(() =>
        guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
      );
      expect(result).toBe(true);
    }
    return TestBed.inject(Store);
  }

  it.each(['billing', 'billing/invoices/:id'])(
    "'%s' makes the manage modal's state selectable",
    async (path) => {
      const store = await activate(path);
      const { BillingHealthState } = await import(
        './features/admin/billing-health.state'
      );
      expect(() =>
        store.selectSnapshot(BillingHealthState.invoiceFeedback),
      ).not.toThrow();
      expect(store.selectSnapshot(BillingHealthState.invoiceFeedback)).toBeNull();
    },
  );

  it('registers the in-shell admin error route', async () => {
    const route = adminChildren().find((r) => r.path === 'error');
    expect(route?.loadComponent).toBeDefined();
    const { AdminErrorComponent } = await import(
      './features/admin/admin-error.component'
    );
    expect(await route?.loadComponent?.()).toBe(AdminErrorComponent);
  });
});
