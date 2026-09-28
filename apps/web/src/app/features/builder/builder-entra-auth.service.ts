import { inject, Injectable } from '@angular/core';
import { ConfigService } from '../../core/config/config.service';
import {
  createCodeChallenge,
  createCodeVerifier,
  createOAuthState,
} from '../admin/admin-entra-pkce';

/**
 * Microsoft Entra External ID sign-in orchestration for the builder
 * portal (auth/05, builder org accounts).
 *
 * Mirrors `AdminEntraAuthService` (auth/02) but resolves the builder
 * memberships instead of staff roles: `startSignIn()` generates a PKCE
 * pair + OAuth state, persists them in sessionStorage under
 * builder-scoped keys, and redirects the browser to the Microsoft-hosted
 * authorize endpoint. The `/builder/auth/callback` page consumes the
 * stored pair, validates the returned state (CSRF), and hands the code +
 * verifier to the backend `POST /api/v1/builder/auth/entra/callback`.
 *
 * Tenant wiring comes from app-config (`builder.entra`). While the
 * compiled placeholders are still in place the flow refuses to start and
 * the login page renders the not-configured copy instead.
 *
 * The PKCE crypto helpers are shared with the admin flow
 * (`admin-entra-pkce`); only the storage keys, callback URI, and config
 * source are builder-specific.
 */
@Injectable({ providedIn: 'root' })
export class BuilderEntraAuthService {
  private readonly config = inject(ConfigService);

  /** sessionStorage keys for the in-flight PKCE/state pair. */
  static readonly STATE_KEY = 'feasly.builder.entra.state';
  static readonly VERIFIER_KEY = 'feasly.builder.entra.codeVerifier';

  /**
   * True when the deployed app-config carries real Entra tenant values.
   * The compiled defaults are the literal `ENTRA_*` placeholders — the
   * flow must not start against those.
   */
  isConfigured(): boolean {
    const entra = this.config.get('copy').builder.entra;
    return [entra.tenantSubdomain, entra.tenantId, entra.clientId, entra.userFlow].every(
      (value) =>
        typeof value === 'string' &&
        value.length > 0 &&
        !value.startsWith('ENTRA_'),
    );
  }

  /**
   * Redirect URI the authorize request uses. The callback page sends the
   * identical value when exchanging the code — Entra requires a byte
   * match, so both sides derive it here.
   */
  callbackRedirectUri(): string {
    return `${window.location.origin}/builder/auth/callback`;
  }

  /**
   * Build the Microsoft-hosted authorize URL, persisting the PKCE
   * verifier + state first. Throws when the tenant is not configured.
   */
  async buildAuthorizeUrl(redirectUri: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Entra is not configured');
    }
    const entra = this.config.get('copy').builder.entra;
    const verifier = createCodeVerifier();
    const challenge = await createCodeChallenge(verifier);
    const state = createOAuthState();
    sessionStorage.setItem(BuilderEntraAuthService.VERIFIER_KEY, verifier);
    sessionStorage.setItem(BuilderEntraAuthService.STATE_KEY, state);
    const params = new URLSearchParams({
      client_id: entra.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      // Entra External ID user flow — without `p` Entra doesn't know which
      // sign-up/sign-in flow to run and rejects the request.
      p: entra.userFlow,
    });
    const authorizeUrl = entra.authorizeUrlTemplate
      .replace('{tenantSubdomain}', entra.tenantSubdomain)
      .replace('{tenantId}', entra.tenantId);
    return `${authorizeUrl}?${params.toString()}`;
  }

  /** Persist the PKCE pair and redirect the browser to Entra. */
  async startSignIn(): Promise<void> {
    window.location.href = await this.buildAuthorizeUrl(
      this.callbackRedirectUri(),
    );
  }

  /**
   * Read and clear the stored PKCE verifier + state. The callback page
   * consumes this exactly once: clearing on read means a replayed
   * callback URL can't be exchanged twice.
   */
  consumeStoredFlow(): { state: string | null; codeVerifier: string | null } {
    const state = sessionStorage.getItem(BuilderEntraAuthService.STATE_KEY);
    const codeVerifier = sessionStorage.getItem(
      BuilderEntraAuthService.VERIFIER_KEY,
    );
    sessionStorage.removeItem(BuilderEntraAuthService.STATE_KEY);
    sessionStorage.removeItem(BuilderEntraAuthService.VERIFIER_KEY);
    return { state, codeVerifier };
  }

  /**
   * Build the full Entra end-session URL for sign-out. Mirrors the admin
   * helper: `id_token_hint` (the id_token captured at sign-in, returned
   * by the backend on logout) tells Entra exactly which session to end,
   * so it skips the "Pick an account" picker (logout UX, Karan 2026-09-28).
   * Pure (no navigation) so it is unit-testable.
   */
  buildEntraLogoutUrl(
    entraLogoutUrl: string,
    idTokenHint?: string | null,
  ): string {
    const postLogoutRedirectUri = `${window.location.origin}/builder/login`;
    const params = new URLSearchParams({
      post_logout_redirect_uri: postLogoutRedirectUri,
    });
    if (idTokenHint) {
      params.set('id_token_hint', idTokenHint);
    }
    return `${entraLogoutUrl}?${params.toString()}`;
  }

  /**
   * Full-page navigation to the Entra end-session endpoint, killing the
   * IdP session. The `post_logout_redirect_uri` brings the browser back
   * to /builder/login afterwards — it must be registered as a logout URL
   * on the builder app registration (portal step; see
   * docs/auth/entra-manual-changes.md).
   *
   * Without this, the Entra cookie survives our session revocation and
   * the next "Sign in" silently re-authenticates. Null/empty URL (builder
   * Entra unprovisioned) → no redirect, returns false.
   */
  redirectToEntraLogout(
    entraLogoutUrl: string | null,
    idTokenHint?: string | null,
  ): boolean {
    if (!entraLogoutUrl) {
      return false;
    }
    window.location.href = this.buildEntraLogoutUrl(
      entraLogoutUrl,
      idTokenHint,
    );
    this.signOutRedirectInitiated = true;
    return true;
  }

  /**
   * True when the last sign-out triggered the Entra end-session redirect.
   * Consumed once by the sign-out caller to decide whether its own
   * navigation is still needed.
   */
  consumeSignOutRedirect(): boolean {
    const initiated = this.signOutRedirectInitiated;
    this.signOutRedirectInitiated = false;
    return initiated;
  }

  /** Set when `redirectToEntraLogout` fires; read via `consumeSignOutRedirect`. */
  private signOutRedirectInitiated = false;
}
