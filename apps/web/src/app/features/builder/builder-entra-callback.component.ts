import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { BuilderAuthApiService } from './builder-auth-api.service';
import { BuilderEntraAuthService } from './builder-entra-auth.service';
import {
  CompleteBuilderEntraSignIn,
  FailBuilderEntraSignIn,
  SetBuilderActiveOrg,
} from './builder.actions';
import type { EntraCallbackErrorKind } from './builder-auth.contracts';

type CallbackStatus = 'verifying' | 'error';

/**
 * Builder Entra sign-in callback (auth/05, builder org accounts).
 *
 * Route: `/builder/auth/callback` — the `redirect_uri` registered with
 * the builder Entra app. Entra redirects here with `?code=…&state=…` (or
 * `?error=access_denied` when the user cancels).
 *
 * Flow:
 * 1. `error` param (or a missing `code`) → 'cancelled' — the sign-in
 *    didn't complete.
 * 2. The returned `state` must match the one stored before the redirect —
 *    mismatch → 'state-mismatch' (possible CSRF). The stored PKCE pair is
 *    consumed exactly once, so a replayed callback URL can't re-exchange.
 * 3. Otherwise POST `{ code, codeVerifier, redirectUri }` to the backend
 *    `POST /api/v1/builder/auth/entra/callback`; the backend resolves the
 *    user's builder memberships. On success dispatch
 *    `CompleteBuilderEntraSignIn` and route:
 *    - one membership → set it active, go to `/builder`;
 *    - several → go to `/builder/org-picker`;
 *    - none → the backend 403s (no enumeration); the UI treats it as
 *      'cancelled' with the generic copy.
 *    Backend/network failure → 'transient'.
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
  selector: 'app-builder-entra-callback',
  standalone: true,
  templateUrl: './builder-entra-callback.component.html',
  styleUrls: ['./builder-login.component.scss'],
})
export class BuilderEntraCallbackComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private readonly api = inject(BuilderAuthApiService);
  private readonly entra = inject(BuilderEntraAuthService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  /** Buyer-grade callback copy (ConfigService, `copy.builder`). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected readonly status = signal<CallbackStatus>('verifying');
  protected readonly errorKind = signal<EntraCallbackErrorKind>('cancelled');

  constructor() {
    this.seo.setPage({
      title: 'Completing sign in — Feasly',
      description: 'Completing builder sign in.',
      path: '/builder/auth/callback',
    });
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
            new CompleteBuilderEntraSignIn(
              response.sessionToken,
              response.user.email,
              response.user.name,
              response.memberships,
            ),
          );
          if (response.memberships.length === 1) {
            const only = response.memberships[0];
            this.store.dispatch(
              new SetBuilderActiveOrg(only.builderId, only.builderName, only.role),
            );
            void this.router.navigate(['/builder']);
          } else {
            // Zero memberships: the backend 403s, so reaching here with an
            // empty list means "no org" — the picker explains it. Several:
            // the user picks.
            void this.router.navigate(['/builder/org-picker']);
          }
        },
        error: () => {
          this.fail('transient');
        },
      });
  }

  private fail(kind: EntraCallbackErrorKind): void {
    this.store.dispatch(new FailBuilderEntraSignIn(kind));
    this.errorKind.set(kind);
    this.status.set('error');
  }

  protected backToLogin(): void {
    void this.router.navigate(['/builder/login']);
  }

  protected errorText(): string {
    switch (this.errorKind()) {
      case 'state-mismatch':
        return this.copy.entraCallbackStateMismatch;
      case 'transient':
        return this.copy.entraCallbackTransient;
      case 'cancelled':
      default:
        return this.copy.entraCallbackCancelled;
    }
  }
}
