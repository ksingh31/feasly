/**
 * Admin verify component tests (admin/01).
 *
 * P0 regression (2026-09-26): the app runs zoneless change detection (no
 * zone.js — `ZONELESS_ENABLED` defaults to true), so `status` MUST be a
 * signal. The old plain-field write inside the HTTP error callback never
 * scheduled change detection, leaving `/admin/verify` stuck on
 * "Verifying sign in / Checking your sign-in link…" forever — past the
 * 15s rxjs timeout, never the error state.
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminVerifyComponent } from './admin-verify.component';
import { AdminAuthApiService } from './admin-auth-api.service';
import { SeoService } from '../../core/seo/seo.service';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

async function setup(opts: {
  token?: string;
  verify: () => Observable<unknown>;
}) {
  TestBed.resetTestingModule();
  const api = { verifyMagicLink: vi.fn().mockImplementation(opts.verify) };
  const seo = { setPage: vi.fn() };
  const paramMap = {
    get: (key: string): string | null =>
      key === 'token' ? (opts.token ?? null) : null,
  };

  TestBed.configureTestingModule({
    imports: [AdminVerifyComponent, BlankComponent],
    providers: [
      provideRouter([
        { path: 'admin/login', component: BlankComponent },
        { path: 'admin/leads', component: BlankComponent },
      ]),
      { provide: AdminAuthApiService, useValue: api },
      { provide: SeoService, useValue: seo },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: paramMap } },
      },
    ],
  });
  const fixture: ComponentFixture<AdminVerifyComponent> =
    TestBed.createComponent(AdminVerifyComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api };
}

describe('AdminVerifyComponent (admin/01)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('P0: status is a signal so the error state renders under zoneless change detection', async () => {
    const { fixture } = await setup({
      token: 'tok123',
      verify: () => throwError(() => new Error('denied')),
    });
    const component = fixture.componentInstance as unknown as {
      status: unknown;
    };
    // Signals are functions; a plain field would be a string here. The P0
    // hung because a plain-field write in the error callback never
    // re-rendered the template.
    expect(typeof component.status).toBe('function');
    fixture.detectChanges();
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('This sign-in link is invalid or has expired.');
  });

  it('shows the verifying state while the request is in flight', async () => {
    const { fixture } = await setup({
      token: 'tok123',
      // Never emits: the request is still pending.
      verify: () => new Observable<never>(() => {}),
    });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Checking your sign-in link');
  });

  it('navigates to /admin/leads on successful verify', async () => {
    const { fixture } = await setup({
      token: 'tok123',
      verify: () => of({ authenticated: true, email: 'admin@example.com' }),
    });
    const router = TestBed.inject(Router);
    const navigate = vi
      .spyOn(router, 'navigate')
      .mockResolvedValue(true as never);
    // Re-run ngOnInit with the spy in place.
    fixture.componentInstance.ngOnInit();
    expect(navigate).toHaveBeenCalledWith(['/admin/leads']);
    navigate.mockRestore();
  });

  it('redirects to /admin/login when no token is present', async () => {
    const { fixture } = await setup({
      verify: () => of({ authenticated: true, email: 'admin@example.com' }),
    });
    // ngOnInit already ran during setup and navigated to /admin/login.
    const router = TestBed.inject(Router);
    expect(router.url).toBe('/admin/login');
    expect(fixture.componentInstance).toBeTruthy();
  });
});
