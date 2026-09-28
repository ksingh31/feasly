/**
 * Entra callback component specs (auth/02 pivot).
 *
 * - `error=access_denied` (user cancelled) and a missing `code` both
 *   render the buyer-grade "didn't complete" copy and dispatch
 *   `FailEntraSignIn('cancelled')` — no backend call.
 * - A `state` mismatch dispatches `FailEntraSignIn('state-mismatch')`
 *   without touching the backend (CSRF fail-closed).
 * - Matching state + code POSTs `{ code, codeVerifier, redirectUri }` to
 *   the backend; on success it dispatches `CompleteEntraSignIn` and
 *   routes to `/admin`.
 * - A backend failure renders the transient copy and dispatches
 *   `FailEntraSignIn('transient')`.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminEntraCallbackComponent } from './admin-entra-callback.component';
import { AdminAuthApiService } from './admin-auth-api.service';
import { AdminEntraAuthService } from './admin-entra-auth.service';
import { AdminAuthState } from './admin-auth.state';
import { CompleteEntraSignIn, FailEntraSignIn } from './admin-auth.actions';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';

function setup(opts: {
  query: Record<string, string | null>;
  storedState?: string | null;
  storedVerifier?: string | null;
  exchangeOk?: boolean;
}) {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn(), setForRoute: vi.fn() };
  const paramMap = {
    get: (key: string): string | null => opts.query[key] ?? null,
  };
  const dispatched: unknown[] = [];
  const store = {
    dispatch: vi.fn((action: unknown) => {
      dispatched.push(action);
      return of(null);
    }),
  };
  const exchangeEntraCode = vi.fn().mockReturnValue(
    opts.exchangeOk === false
      ? throwError(() => ({ retryable: true }))
      : of({
          authenticated: true,
          user: {
            email: 'admin@example.com',
            name: 'Admin User',
            staffRole: 'super_admin',
          },
          sessionToken: 'sess-entra-abc',
        }),
  );
  const api = { exchangeEntraCode };
  const entra = {
    consumeStoredFlow: vi.fn().mockReturnValue({
      state: opts.storedState ?? null,
      codeVerifier: opts.storedVerifier ?? null,
    }),
    callbackRedirectUri: () => 'https://app.example.com/admin/auth/callback',
  };
  const navigate = vi.fn();
  const router = { navigate };

  TestBed.configureTestingModule({
    imports: [AdminEntraCallbackComponent],
    providers: [
      provideStore([AdminAuthState]),
      { provide: Store, useValue: store },
      { provide: SeoService, useValue: seo },
      { provide: ConfigService, useValue: { get: () => ({ admin: { auth: copyAuth() } }) } },
      { provide: AdminAuthApiService, useValue: api },
      { provide: AdminEntraAuthService, useValue: entra },
      { provide: Router, useValue: router },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: paramMap } },
      },
    ],
  });
  const fixture: ComponentFixture<AdminEntraCallbackComponent> =
    TestBed.createComponent(AdminEntraCallbackComponent);
  fixture.detectChanges();
  return { fixture, dispatched, exchangeEntraCode, entra, navigate };
}

/** Mirror of the compiled auth copy (defaults) for the assertions. */
function copyAuth() {
  return {
    loginExpired: 'Your admin session expired. Sign in again.',
    entraSignInLabel: 'Sign in →',
    entraSignInIntro: 'Sign in with your Feasly admin account to continue.',
    entraIncomplete: "Sign-in didn't complete — try again.",
    entraStateMismatch: "Sign-in didn't complete — try again.",
    entraTransient: 'Something went wrong. Please try again.',
    entraNotConfigured: 'Sign-in is not set up yet. Contact support.',
  };
}

describe('AdminEntraCallbackComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the buyer-grade copy when Entra reports access_denied', () => {
    const { fixture, dispatched, exchangeEntraCode } = setup({
      query: { error: 'access_denied', error_description: 'user cancelled' },
    });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("Sign-in didn't complete — try again.");
    expect(exchangeEntraCode).not.toHaveBeenCalled();
    const fail = dispatched.find((a) => a instanceof FailEntraSignIn) as FailEntraSignIn;
    expect(fail.error).toBe('cancelled');
  });

  it('treats a missing code as cancelled without calling the backend', () => {
    const { dispatched, exchangeEntraCode } = setup({ query: {} });
    expect(exchangeEntraCode).not.toHaveBeenCalled();
    const fail = dispatched.find((a) => a instanceof FailEntraSignIn) as FailEntraSignIn;
    expect(fail.error).toBe('cancelled');
  });

  it('fails closed on a state mismatch without calling the backend', () => {
    const { fixture, dispatched, exchangeEntraCode, entra } = setup({
      query: { code: 'auth-code', state: 'attacker-state' },
      storedState: 'real-state',
      storedVerifier: 'real-verifier',
    });
    expect(entra.consumeStoredFlow).toHaveBeenCalled();
    expect(exchangeEntraCode).not.toHaveBeenCalled();
    const fail = dispatched.find((a) => a instanceof FailEntraSignIn) as FailEntraSignIn;
    expect(fail.error).toBe('state-mismatch');
    expect((fixture.nativeElement.textContent as string)).toContain(
      "Sign-in didn't complete — try again.",
    );
  });

  it('fails closed when nothing was stored (direct navigation to the callback)', () => {
    const { dispatched, exchangeEntraCode } = setup({
      query: { code: 'auth-code', state: 'some-state' },
    });
    expect(exchangeEntraCode).not.toHaveBeenCalled();
    const fail = dispatched.find((a) => a instanceof FailEntraSignIn) as FailEntraSignIn;
    expect(fail.error).toBe('state-mismatch');
  });

  it('exchanges a valid code, bootstraps the session, and routes to /admin', () => {
    const { dispatched, exchangeEntraCode, navigate } = setup({
      query: { code: 'auth-code', state: 'real-state' },
      storedState: 'real-state',
      storedVerifier: 'real-verifier',
    });
    expect(exchangeEntraCode).toHaveBeenCalledWith({
      code: 'auth-code',
      codeVerifier: 'real-verifier',
      redirectUri: 'https://app.example.com/admin/auth/callback',
    });
    const complete = dispatched.find(
      (a) => a instanceof CompleteEntraSignIn,
    ) as CompleteEntraSignIn;
    expect(complete.sessionToken).toBe('sess-entra-abc');
    expect(complete.email).toBe('admin@example.com');
    expect(complete.name).toBe('Admin User');
    expect(complete.staffRole).toBe('super_admin');
    expect(navigate).toHaveBeenCalledWith(['/admin']);
  });

  it('renders the transient copy when the backend exchange fails', () => {
    const { fixture, dispatched } = setup({
      query: { code: 'auth-code', state: 'real-state' },
      storedState: 'real-state',
      storedVerifier: 'real-verifier',
      exchangeOk: false,
    });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Something went wrong. Please try again.');
    const fail = dispatched.find((a) => a instanceof FailEntraSignIn) as FailEntraSignIn;
    expect(fail.error).toBe('transient');
  });
});
