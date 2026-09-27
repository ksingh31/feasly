/**
 * Admin verify component tests (admin/01).
 *
 * P0 regression (2026-09-26): the app runs zoneless change detection (no
 * zone.js — `ZONELESS_ENABLED` defaults to true), so `status` MUST be a
 * signal. The old plain-field write inside the HTTP error callback never
 * scheduled change detection, leaving `/admin/verify` stuck on
 * "Verifying sign in / Checking your sign-in link…" forever — past the
 * 15s rxjs timeout, never the error state.
 *
 * The component dispatches `VerifyAdminToken` through the NGXS store and
 * navigates on `AdminAuthState.authenticated` (ADM-10 bearer flow).
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminVerifyComponent } from './admin-verify.component';
import { AdminAuthState } from './admin-auth.state';
import { VerifyAdminToken } from './admin-auth.actions';
import { SeoService } from '../../core/seo/seo.service';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

async function setup(opts: { token?: string; verifyOk: boolean }) {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn() };
  const paramMap = {
    get: (key: string): string | null =>
      key === 'token' ? (opts.token ?? null) : null,
  };
  // The real VerifyAdminToken handler catches failures and returns of(null);
  // the outcome surfaces via selectSnapshot(authenticated).
  const dispatch = vi.fn().mockReturnValue(of(null));
  const store = {
    dispatch,
    selectSnapshot: vi.fn().mockReturnValue(opts.verifyOk),
  };

  TestBed.configureTestingModule({
    imports: [AdminVerifyComponent, BlankComponent],
    providers: [
      provideRouter([
        { path: 'admin/login', component: BlankComponent },
        { path: 'admin/leads', component: BlankComponent },
      ]),
      provideStore([AdminAuthState]),
      { provide: SeoService, useValue: seo },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: paramMap } },
      },
    ],
  });
  // Override the real store with the mock for dispatch/selectSnapshot.
  const { Store: StoreToken } = await import('@ngxs/store');
  TestBed.overrideProvider(StoreToken, { useValue: store });
  const fixture: ComponentFixture<AdminVerifyComponent> =
    TestBed.createComponent(AdminVerifyComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, dispatch, store };
}

describe('AdminVerifyComponent (admin/01)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('P0: status is a signal so the error state renders under zoneless change detection', async () => {
    const { fixture } = await setup({ token: 'tok123', verifyOk: false });
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

  it('dispatches VerifyAdminToken with the token from the URL', async () => {
    const { dispatch } = await setup({ token: 'tok123', verifyOk: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0];
    expect(action).toBeInstanceOf(VerifyAdminToken);
    expect(action.token).toBe('tok123');
  });

  it('navigates to /admin/leads on successful verify', async () => {
    const { fixture } = await setup({ token: 'tok123', verifyOk: true });
    const router = TestBed.inject(Router);
    const navigate = vi
      .spyOn(router, 'navigate')
      .mockResolvedValue(true as never);
    // Re-run ngOnInit with the spy in place.
    fixture.componentInstance.ngOnInit();
    expect(navigate).toHaveBeenCalledWith(['/admin/leads']);
    navigate.mockRestore();
  });

  it('shows the error state when verification fails', async () => {
    const { fixture } = await setup({ token: 'tok123', verifyOk: false });
    fixture.detectChanges();
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('This sign-in link is invalid or has expired.');
  });

  it('redirects to /admin/login when no token is present', async () => {
    const { dispatch } = await setup({ verifyOk: true });
    // ngOnInit already ran during setup and navigated to /admin/login.
    const router = TestBed.inject(Router);
    expect(router.url).toBe('/admin/login');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reads the authenticated flag from AdminAuthState', async () => {
    const { store } = await setup({ token: 'tok123', verifyOk: true });
    expect(store.selectSnapshot).toHaveBeenCalledWith(
      AdminAuthState.authenticated,
    );
  });
});
