/**
 * Builder Entra callback component specs (auth/05).
 *
 * - `error=access_denied` (user cancelled) and a missing `code` both
 *   render the buyer-grade "didn't complete" copy and dispatch
 *   `FailBuilderEntraSignIn('cancelled')` — no backend call.
 * - A `state` mismatch dispatches `FailBuilderEntraSignIn('state-mismatch')`
 *   without touching the backend (CSRF fail-closed).
 * - Matching state + code POSTs `{ code, codeVerifier, redirectUri }` to
 *   the backend; on success it dispatches `CompleteBuilderEntraSignIn`.
 *   One membership → sets it active and routes to `/builder`;
 *   several → routes to `/builder/org-picker`.
 * - A backend failure renders the transient copy and dispatches
 *   `FailBuilderEntraSignIn('transient')`.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderEntraCallbackComponent } from './builder-entra-callback.component';
import { BuilderAuthApiService } from './builder-auth-api.service';
import { BuilderEntraAuthService } from './builder-entra-auth.service';
import {
  CompleteBuilderEntraSignIn,
  FailBuilderEntraSignIn,
  SetBuilderActiveOrg,
} from './builder.actions';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import type { BuilderOrgMembership } from './builder-auth.contracts';

const CANCELLED_COPY = "Sign-in didn't complete — try again.";
const TRANSIENT_COPY = 'Something went wrong. Please try again.';

function membership(id: string, name: string): BuilderOrgMembership {
  return { builderId: id, builderName: name, role: 'builder_admin' };
}

function setup(opts: {
  query: Record<string, string | null>;
  storedState?: string | null;
  storedVerifier?: string | null;
  exchangeOk?: boolean;
  memberships?: BuilderOrgMembership[];
}) {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn() };
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
          user: { email: 'builder@example.com', name: 'Builder User' },
          sessionToken: 'sess-entra-abc',
          memberships: opts.memberships ?? [membership('b1', 'Acme Builders')],
        }),
  );
  const api = { exchangeEntraCode };
  const entra = {
    consumeStoredFlow: vi.fn(() => ({
      state: opts.storedState ?? null,
      codeVerifier: opts.storedVerifier ?? null,
    })),
    callbackRedirectUri: () => 'https://app.example/builder/auth/callback',
  };
  const router = { navigate: vi.fn().mockResolvedValue(true) };
  const config = {
    get: (section: string) =>
      section === 'copy'
        ? {
            builder: {
              entraCallbackVerifying: 'Completing sign in…',
              entraCallbackCancelled: CANCELLED_COPY,
              entraCallbackStateMismatch: CANCELLED_COPY,
              entraCallbackTransient: TRANSIENT_COPY,
              entraCallbackBackToLogin: 'Back to sign in',
            },
          }
        : {},
  };

  TestBed.configureTestingModule({
    imports: [BuilderEntraCallbackComponent],
    providers: [
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: paramMap } } },
      { provide: Router, useValue: router },
      { provide: Store, useValue: store },
      { provide: BuilderAuthApiService, useValue: api },
      { provide: BuilderEntraAuthService, useValue: entra },
      { provide: ConfigService, useValue: config },
      { provide: SeoService, useValue: seo },
    ],
  });
  const fixture: ComponentFixture<BuilderEntraCallbackComponent> =
    TestBed.createComponent(BuilderEntraCallbackComponent);
  fixture.detectChanges();
  return { fixture, dispatched, exchangeEntraCode, entra, router };
}

describe('BuilderEntraCallbackComponent (auth/05)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the verifying status while exchanging', () => {
    const { fixture } = setup({
      query: { code: 'code-1', state: 's1' },
      storedState: 's1',
      storedVerifier: 'v1',
    });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Completing sign in…');
  });

  it('error=access_denied dispatches cancelled and never calls the backend', () => {
    const { fixture, dispatched, exchangeEntraCode } = setup({
      query: { error: 'access_denied' },
    });
    expect(exchangeEntraCode).not.toHaveBeenCalled();
    expect(
      dispatched.some((a) => a instanceof FailBuilderEntraSignIn),
    ).toBe(true);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(CANCELLED_COPY);
  });

  it('missing code dispatches cancelled without a backend call', () => {
    const { dispatched, exchangeEntraCode } = setup({ query: {} });
    expect(exchangeEntraCode).not.toHaveBeenCalled();
    const failure = dispatched.find(
      (a) => a instanceof FailBuilderEntraSignIn,
    ) as FailBuilderEntraSignIn;
    expect(failure.kind).toBe('cancelled');
  });

  it('state mismatch dispatches state-mismatch without a backend call', () => {
    const { dispatched, exchangeEntraCode } = setup({
      query: { code: 'code-1', state: 'attacker' },
      storedState: 's1',
      storedVerifier: 'v1',
    });
    expect(exchangeEntraCode).not.toHaveBeenCalled();
    const failure = dispatched.find(
      (a) => a instanceof FailBuilderEntraSignIn,
    ) as FailBuilderEntraSignIn;
    expect(failure.kind).toBe('state-mismatch');
  });

  it('single membership: completes sign-in, sets active org, routes to /builder', () => {
    const { dispatched, exchangeEntraCode, router, entra } = setup({
      query: { code: 'code-1', state: 's1' },
      storedState: 's1',
      storedVerifier: 'v1',
      memberships: [membership('b1', 'Acme Builders')],
    });
    expect(exchangeEntraCode).toHaveBeenCalledWith({
      code: 'code-1',
      codeVerifier: 'v1',
      redirectUri: 'https://app.example/builder/auth/callback',
    });
    // The stored PKCE pair is consumed exactly once.
    expect(entra.consumeStoredFlow).toHaveBeenCalledTimes(1);
    expect(
      dispatched.some((a) => a instanceof CompleteBuilderEntraSignIn),
    ).toBe(true);
    const setOrg = dispatched.find(
      (a) => a instanceof SetBuilderActiveOrg,
    ) as SetBuilderActiveOrg;
    expect(setOrg.builderId).toBe('b1');
    expect(router.navigate).toHaveBeenCalledWith(['/builder']);
  });

  it('multiple memberships: routes to /builder/org-picker', () => {
    const { dispatched, router } = setup({
      query: { code: 'code-1', state: 's1' },
      storedState: 's1',
      storedVerifier: 'v1',
      memberships: [membership('b1', 'Acme'), membership('b2', 'Beta')],
    });
    expect(
      dispatched.some((a) => a instanceof CompleteBuilderEntraSignIn),
    ).toBe(true);
    expect(
      dispatched.some((a) => a instanceof SetBuilderActiveOrg),
    ).toBe(false);
    expect(router.navigate).toHaveBeenCalledWith(['/builder/org-picker']);
  });

  it('backend failure renders the transient copy and dispatches transient', () => {
    const { fixture, dispatched } = setup({
      query: { code: 'code-1', state: 's1' },
      storedState: 's1',
      storedVerifier: 'v1',
      exchangeOk: false,
    });
    const failure = dispatched.find(
      (a) => a instanceof FailBuilderEntraSignIn,
    ) as FailBuilderEntraSignIn;
    expect(failure.kind).toBe('transient');
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(TRANSIENT_COPY);
  });
});
