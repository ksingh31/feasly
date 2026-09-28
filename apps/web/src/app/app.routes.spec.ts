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
import { provideRouter, Router, RouterOutlet } from '@angular/router';
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

describe('retired /admin/verify route', () => {
  beforeEach(() => {
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
