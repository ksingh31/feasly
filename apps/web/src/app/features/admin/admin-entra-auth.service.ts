import { inject, Injectable } from '@angular/core';
import { ConfigService } from '../../core/config/config.service';
import {
  createCodeChallenge,
  createCodeVerifier,
  createOAuthState,
} from './admin-entra-pkce';

/**
 * Microsoft Entra External ID sign-in orchestration (auth/02 pivot,
 * AUTH-02).
 *
 * The SPA never touches Entra tokens: `startSignIn()` generates a PKCE
 * pair + OAuth state, persists them in sessionStorage, and redirects the
 * browser to the Microsoft-hosted authorize endpoint. The
 * `/admin/auth/callback` page consumes the stored pair, validates the
 * returned state (CSRF), and hands the code + verifier to the backend
 * `POST /api/v1/admin/auth/entra/callback` (see AdminAuthApiService).
 *
 * Tenant wiring comes from app-config (`admin.entra`:
 * ENTRA_TENANT_SUBDOMAIN / ENTRA_TENANT_ID / ENTRA_CLIENT_ID). While the
 * compiled placeholders are still in place the flow refuses to start and
 * the login page renders the not-configured copy instead.
 */
@Injectable({ providedIn: 'root' })
export class AdminEntraAuthService {
  private readonly config = inject(ConfigService);

  /** sessionStorage keys for the in-flight PKCE/state pair. */
  static readonly STATE_KEY = 'feasly.admin.entra.state';
  static readonly VERIFIER_KEY = 'feasly.admin.entra.codeVerifier';

  /**
   * True when the deployed app-config carries real Entra tenant values.
   * The compiled defaults are the literal `ENTRA_*` placeholders — the
   * flow must not start against those.
   */
  isConfigured(): boolean {
    const entra = this.config.get('admin').entra;
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
    return `${window.location.origin}/admin/auth/callback`;
  }

  /**
   * Build the Microsoft-hosted authorize URL, persisting the PKCE
   * verifier + state first. Throws when the tenant is not configured.
   */
  async buildAuthorizeUrl(redirectUri: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Entra is not configured');
    }
    const entra = this.config.get('admin').entra;
    const verifier = createCodeVerifier();
    const challenge = await createCodeChallenge(verifier);
    const state = createOAuthState();
    sessionStorage.setItem(AdminEntraAuthService.VERIFIER_KEY, verifier);
    sessionStorage.setItem(AdminEntraAuthService.STATE_KEY, state);
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
    const state = sessionStorage.getItem(AdminEntraAuthService.STATE_KEY);
    const codeVerifier = sessionStorage.getItem(
      AdminEntraAuthService.VERIFIER_KEY,
    );
    sessionStorage.removeItem(AdminEntraAuthService.STATE_KEY);
    sessionStorage.removeItem(AdminEntraAuthService.VERIFIER_KEY);
    return { state, codeVerifier };
  }
}
