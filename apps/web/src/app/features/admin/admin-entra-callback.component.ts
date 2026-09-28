import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { AdminAuthApiService } from './admin-auth-api.service';
import { AdminEntraAuthService } from './admin-entra-auth.service';
import { CompleteEntraSignIn, FailEntraSignIn } from './admin-auth.actions';
import type { EntraCallbackErrorKind } from './admin-auth.state';

type CallbackStatus = 'verifying' | 'error';

/**
 * Entra sign-in callback (auth/02 pivot, AUTH-02).
 *
 * Route: `/admin/auth/callback` — the `redirect_uri` registered with the
 * Entra app. Entra redirects here with `?code=…&state=…` (or
 * `?error=access_denied` when the user cancels).
 *
 * Flow:
 * 1. `error` param (or a missing `code`) → 'cancelled' — the sign-in
 *    didn't complete.
 * 2. The returned `state` must match the one stored before the redirect —
 *    mismatch → 'state-mismatch' (possible CSRF). The stored PKCE pair is
 *    consumed exactly once, so a replayed callback URL can't re-exchange.
 * 3. Otherwise POST `{ code, codeVerifier, redirectUri }` to the backend
 *    `POST /api/v1/admin/auth/entra/callback`; on success dispatch
 *    `CompleteEntraSignIn` (bootstraps NGXS auth state) and route to
 *    `/admin`. Backend/network failure → 'transient'.
 *
 * All three failure kinds render the same buyer-grade line —
 * "Sign-in didn't complete — try again." — plus a way back to login.
 *
 * `status` is a signal, not a plain field: the app runs zoneless change
 * detection, so the error write inside the HTTP callback must be a signal
 * to re-render.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-entra-callback',
  standalone: true,
  templateUrl: './admin-entra-callback.component.html',
  styleUrls: ['./admin-login.component.scss'],
})
export class AdminEntraCallbackComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private readonly api = inject(AdminAuthApiService);
  private readonly entra = inject(AdminEntraAuthService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  /** Buyer-grade callback copy (ConfigService, `copy.admin.auth`). */
  protected readonly copy = inject(ConfigService).get('copy').admin.auth;

  protected readonly status = signal<CallbackStatus>('verifying');
  protected readonly errorKind = signal<EntraCallbackErrorKind>('cancelled');

  constructor() {
    // Outside the admin shell — resolves the config-owned title from the
    // seo-routes table.
    this.seo.setForRoute('admin/auth/callback');
  }

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    const code = params.get('code');
    const returnedState = params.get('state');

    // Entra reports user cancellation (and any provider-side failure) via
    // `error`; a missing code is equally unusable.
    if (params.get('error') || !code) {
      this.fail('cancelled');
      return;
    }

    const { state, codeVerifier } = this.entra.consumeStoredFlow();
    if (!state || !codeVerifier || state !== returnedState) {
      this.fail('state-mismatch');
      return;
    }

    this.api
      .exchangeEntraCode({
        code,
        codeVerifier,
        redirectUri: this.entra.callbackRedirectUri(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.store.dispatch(
            new CompleteEntraSignIn(
              response.sessionToken,
              response.user.email,
              response.user.name,
              response.user.staffRole,
            ),
          );
          void this.router.navigate(['/admin']);
        },
        error: () => {
          this.fail('transient');
        },
      });
  }

  private fail(kind: EntraCallbackErrorKind): void {
    this.store.dispatch(new FailEntraSignIn(kind));
    this.errorKind.set(kind);
    this.status.set('error');
  }

  protected backToLogin(): void {
    void this.router.navigate(['/admin/login']);
  }

  protected errorText(): string {
    switch (this.errorKind()) {
      case 'state-mismatch':
        return this.copy.entraStateMismatch;
      case 'transient':
        return this.copy.entraTransient;
      case 'cancelled':
      default:
        return this.copy.entraIncomplete;
    }
  }
}
