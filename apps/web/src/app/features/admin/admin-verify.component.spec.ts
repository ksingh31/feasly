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
 * Gesture gate (goal_169560defa2b, 2026-09-27): the token is single-use
 * server-side, so the component must NOT dispatch VerifyAdminToken on
 * init — email link-scanners would burn the token before the human taps
 * it. It renders a one-tap interstitial ("Sign me in →") and verifies
 * only on that click.
 *
 * The component dispatches `VerifyAdminToken` through the NGXS store and
 * navigates on `AdminAuthState.authenticated` (ADM-10 bearer flow).
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminVerifyComponent } from './admin-verify.component';
import { AdminAuthApiService } from './admin-auth-api.service';
import { AdminAuthState, type VerifyErrorKind } from './admin-auth.state';
import { VerifyAdminToken } from './admin-auth.actions';
import { SeoService } from '../../core/seo/seo.service';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

async function setup(opts: {
  token?: string;
  verifyOk: boolean;
  lastVerifyError?: VerifyErrorKind;
  resendOk?: boolean;
}) {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn() };
  const paramMap = {
    get: (key: string): string | null =>
      key === 'token' ? (opts.token ?? null) : null,
  };
  // The real VerifyAdminToken handler catches failures and returns of(null);
  // the outcome surfaces via selectSnapshot(authenticated), and the failure
  // kind via selectSnapshot(lastVerifyError).
  const dispatch = vi.fn().mockReturnValue(of(null));
  const store = {
    dispatch,
    selectSnapshot: vi.fn().mockImplementation((selector: unknown) => {
      if (selector === AdminAuthState.lastVerifyError)
        return opts.lastVerifyError ?? 'invalid';
      if (selector === AdminAuthState.email) return 'admin@example.com';
      return opts.verifyOk;
    }),
  };
  const requestMagicLink = vi.fn().mockReturnValue(
    opts.resendOk === false
      ? throwError(() => ({ code: 'timeout', retryable: true }))
      : of({ sent: true }),
  );
  const api = { requestMagicLink };

  TestBed.configureTestingModule({
    imports: [AdminVerifyComponent, BlankComponent],
    providers: [
      provideRouter([
        { path: 'admin/login', component: BlankComponent },
        { path: 'admin/leads', component: BlankComponent },
      ]),
      provideStore([AdminAuthState]),
      { provide: SeoService, useValue: seo },
      { provide: AdminAuthApiService, useValue: api },
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
  return { fixture, dispatch, store, api };
}

/** Clicks the "Sign me in →" interstitial button. */
async function clickSignIn(
  fixture: ComponentFixture<AdminVerifyComponent>,
): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  const button = fixture.nativeElement.querySelector(
    'button.admin-login__submit',
  ) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  button!.click();
  fixture.detectChanges();
  await fixture.whenStable();
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
    await clickSignIn(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('This sign-in link is invalid or has expired.');
  });

  it('renders the one-tap interstitial instead of verifying on load', async () => {
    const { fixture } = await setup({ token: 'tok123', verifyOk: true });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("You're signing in as");
    expect(text).toContain('Sign me in');
    expect(text).not.toContain('Checking your sign-in link');
  });

  it('does NOT dispatch VerifyAdminToken on init (gesture gate)', async () => {
    const { dispatch } = await setup({ token: 'tok123', verifyOk: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches VerifyAdminToken with the token from the URL on "Sign me in" click', async () => {
    const { fixture, dispatch } = await setup({
      token: 'tok123',
      verifyOk: true,
    });
    await clickSignIn(fixture);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0];
    expect(action).toBeInstanceOf(VerifyAdminToken);
    expect(action.token).toBe('tok123');
  });

  it('ignores repeated clicks on "Sign me in" (single dispatch)', async () => {
    const { fixture, dispatch } = await setup({
      token: 'tok123',
      verifyOk: true,
    });
    await clickSignIn(fixture);
    // A second click must not re-fire the single-use token request.
    fixture.componentInstance['signIn']();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('navigates to /admin/leads on successful verify', async () => {
    const { fixture } = await setup({ token: 'tok123', verifyOk: true });
    const router = TestBed.inject(Router);
    const navigate = vi
      .spyOn(router, 'navigate')
      .mockResolvedValue(true as never);
    await clickSignIn(fixture);
    expect(navigate).toHaveBeenCalledWith(['/admin/leads']);
    navigate.mockRestore();
  });

  it('shows the error state when verification fails', async () => {
    const { fixture } = await setup({ token: 'tok123', verifyOk: false });
    await clickSignIn(fixture);
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
    const { fixture, store } = await setup({
      token: 'tok123',
      verifyOk: true,
    });
    await clickSignIn(fixture);
    expect(store.selectSnapshot).toHaveBeenCalledWith(
      AdminAuthState.authenticated,
    );
  });

  it('shows the already-used copy (not generic expired copy) for consumed tokens', async () => {
    const { fixture } = await setup({
      token: 'tok123',
      verifyOk: false,
      lastVerifyError: 'used',
    });
    await clickSignIn(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('This link was already used');
    expect(text).toContain('Send me a fresh link');
  });

  it('shows the transient copy with Try again, which re-fires verify', async () => {
    const { fixture, dispatch } = await setup({
      token: 'tok123',
      verifyOk: false,
      lastVerifyError: 'transient',
    });
    await clickSignIn(fixture);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Something went wrong while checking your link');
    expect(text).not.toContain('Send me a fresh link');

    const retry = fixture.nativeElement.querySelector(
      'button.admin-login__submit',
    ) as HTMLButtonElement;
    expect(retry.textContent).toContain('Try again');
    retry.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][0]).toBeInstanceOf(VerifyAdminToken);
  });

  it('resend form requests a fresh link and shows the sent confirmation', async () => {
    const { fixture, api } = await setup({
      token: 'tok123',
      verifyOk: false,
      lastVerifyError: 'invalid',
    });
    await clickSignIn(fixture);

    const component = fixture.componentInstance as unknown as {
      resendForm: { controls: { email: { setValue: (v: string) => void } } };
      resend: () => void;
    };
    component.resendForm.controls.email.setValue('admin@example.com');
    fixture.detectChanges();
    component.resend();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.requestMagicLink).toHaveBeenCalledWith({
      email: 'admin@example.com',
    });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Check your email for a fresh sign-in link.');
  });

  it('resend shows an inline error when the request fails', async () => {
    const { fixture } = await setup({
      token: 'tok123',
      verifyOk: false,
      lastVerifyError: 'used',
      resendOk: false,
    });
    await clickSignIn(fixture);

    const component = fixture.componentInstance as unknown as {
      resendForm: { controls: { email: { setValue: (v: string) => void } } };
      resend: () => void;
    };
    component.resendForm.controls.email.setValue('admin@example.com');
    component.resend();
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("We couldn't send the link");
  });
});
