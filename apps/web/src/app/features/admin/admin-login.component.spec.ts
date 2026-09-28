/**
 * Admin login component tests (auth/02).
 *
 * Verifies: the password-first form (approved mockup "Sign in" screen),
 * exact buyer-grade inline error copy for 401/429/transient failures,
 * dispatch of LoginAdminWithPassword with trimmed values, navigation on
 * success, the remember-me default, the show/hide password toggle, the
 * expired-session copy, and the preserved magic-link fallback toggle.
 */
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginComponent } from './admin-login.component';
import { AdminAuthApiService } from './admin-auth-api.service';
import { LoginAdminWithPassword } from './admin-auth.actions';
import {
  AdminAuthState,
  type LoginErrorKind,
} from './admin-auth.state';
import { SeoService } from '../../core/seo/seo.service';

const INVALID_CREDENTIALS_COPY =
  "We don't recognize that email/password combination.";
const RATE_LIMITED_COPY = 'Too many attempts — try again in 15 minutes.';
const TRANSIENT_COPY = 'Something went wrong. Please try again.';
const EXPIRED_COPY = 'Your admin session expired. Sign in again.';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

interface SetupOpts {
  loginError?: LoginErrorKind | null;
  authenticated?: boolean;
  expired?: boolean;
}

async function setup(opts: SetupOpts = {}) {
  TestBed.resetTestingModule();
  const loginErrorSignal = signal<LoginErrorKind | null>(
    opts.loginError ?? null,
  );
  const store = {
    dispatch: vi.fn().mockReturnValue(of(null)),
    selectSignal: vi.fn().mockImplementation((selector: unknown) =>
      selector === AdminAuthState.lastLoginError
        ? loginErrorSignal
        : signal(null),
    ),
    selectSnapshot: vi.fn().mockImplementation((selector: unknown) =>
      selector === AdminAuthState.authenticated
        ? (opts.authenticated ?? false)
        : null,
    ),
  };
  const api = {
    requestMagicLink: vi.fn().mockReturnValue(of({ sent: true as const })),
  };
  const seo = { setPage: vi.fn() };
  const route = {
    snapshot: {
      queryParamMap: {
        get: (key: string): string | null =>
          key === 'expired' && opts.expired ? '1' : null,
      },
    },
  };

  TestBed.configureTestingModule({
    imports: [AdminLoginComponent],
    providers: [
      provideRouter([
        { path: 'admin', component: BlankComponent },
        { path: 'admin/forgot-password', component: BlankComponent },
      ]),
      { provide: Store, useValue: store },
      { provide: AdminAuthApiService, useValue: api },
      { provide: SeoService, useValue: seo },
      { provide: ActivatedRoute, useValue: route },
    ],
  });
  const fixture: ComponentFixture<AdminLoginComponent> =
    TestBed.createComponent(AdminLoginComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const router = TestBed.inject(Router);
  const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  return { fixture, store, api, seo, navigateSpy, loginErrorSignal };
}

/** Structural view of the protected members the tests need (repo
 * convention — see builder-login.component.spec.ts). */
function componentApi(fixture: ComponentFixture<AdminLoginComponent>) {
  return fixture.componentInstance as unknown as {
    form: {
      controls: {
        email: {
          setValue: (v: string) => void;
          markAsTouched: () => void;
        };
        password: {
          setValue: (v: string) => void;
          markAsTouched: () => void;
        };
        rememberMe: { value: boolean };
      };
    };
    magicLinkForm: {
      controls: { email: { setValue: (v: string) => void } };
    };
    mode: { set: (m: 'password' | 'magic-link') => void };
    submitPassword: () => void;
    submitMagicLink: () => void;
    togglePasswordVisibility: () => void;
  };
}

function setPasswordForm(
  fixture: ComponentFixture<AdminLoginComponent>,
  email: string,
  password: string,
) {
  const component = componentApi(fixture);
  component.form.controls.email.setValue(email);
  component.form.controls.password.setValue(password);
  component.form.controls.email.markAsTouched();
  component.form.controls.password.markAsTouched();
}

describe('AdminLoginComponent (auth/02)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the password-first form with the approved copy', async () => {
    const { fixture } = await setup();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Welcome back');
    expect(text).toContain('Admin portal');
    expect(text).toContain('Sign in to manage leads, builders and your team.');
    expect(text).toContain('Forgot password?');
    expect(text).toContain('Remember me on this device');
    // No magic-link form visible until the toggle is used.
    expect(text).not.toContain('Send sign-in link');
  });

  it('checks "Remember me" by default (mockup)', async () => {
    const { fixture } = await setup();
    const component = componentApi(fixture);
    expect(component.form.controls.rememberMe.value).toBe(true);
  });

  it('shows the exact expired-session copy when ?expired=1', async () => {
    const { fixture } = await setup({ expired: true });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(EXPIRED_COPY);
  });

  it('dispatches LoginAdminWithPassword with trimmed values and navigates on success', async () => {
    const { fixture, store, navigateSpy } = await setup({
      authenticated: true,
    });
    const component = componentApi(fixture);
    setPasswordForm(fixture, 'admin@example.com', 's3cret!');
    component.submitPassword();

    expect(store.dispatch).toHaveBeenCalledTimes(1);
    const action = store.dispatch.mock.calls[0][0] as LoginAdminWithPassword;
    expect(action).toBeInstanceOf(LoginAdminWithPassword);
    expect(action.email).toBe('admin@example.com');
    expect(action.password).toBe('s3cret!');
    expect(action.rememberMe).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith(['/admin']);
  });

  it('does not navigate when the login did not authenticate', async () => {
    const { fixture, navigateSpy } = await setup({ authenticated: false });
    const component = componentApi(fixture);
    setPasswordForm(fixture, 'admin@example.com', 's3cret!');
    component.submitPassword();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('does not dispatch with an invalid form', async () => {
    const { fixture, store } = await setup();
    const component = componentApi(fixture);
    setPasswordForm(fixture, 'not-an-email', '');
    component.submitPassword();
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('shows the invalid-credentials copy on 401 (no oracle)', async () => {
    const { fixture } = await setup({ loginError: 'invalid-credentials' });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(INVALID_CREDENTIALS_COPY);
    expect(text).not.toContain('admin@example.com');
  });

  it('shows the rate-limit copy on 429', async () => {
    const { fixture } = await setup({ loginError: 'rate-limited' });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(RATE_LIMITED_COPY);
  });

  it('shows the transient copy on network/5xx failures', async () => {
    const { fixture } = await setup({ loginError: 'transient' });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(TRANSIENT_COPY);
  });

  it('shows no inline error before any attempt', async () => {
    const { fixture } = await setup();
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain(INVALID_CREDENTIALS_COPY);
    expect(text).not.toContain(RATE_LIMITED_COPY);
  });

  it('toggles password visibility', async () => {
    const { fixture } = await setup();
    const component = componentApi(fixture);
    component.togglePasswordVisibility();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '.admin-login__password-wrap input',
    );
    expect(input.type).toBe('text');
    component.togglePasswordVisibility();
    fixture.detectChanges();
    expect(input.type).toBe('password');
  });

  it('toggles to the magic-link fallback and back', async () => {
    const { fixture, api } = await setup();
    const component = componentApi(fixture);

    component.mode.set('magic-link');
    fixture.detectChanges();
    let text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Send sign-in link');

    component.magicLinkForm.controls.email.setValue('admin@example.com');
    component.submitMagicLink();
    expect(api.requestMagicLink).toHaveBeenCalledWith({
      email: 'admin@example.com',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Check your email for your sign-in link.');

    component.mode.set('password');
    fixture.detectChanges();
    text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Welcome back');
  });

  it('sets SEO metadata for the login page', async () => {
    const { seo } = await setup();
    expect(seo.setPage).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/admin/login' }),
    );
  });
});
