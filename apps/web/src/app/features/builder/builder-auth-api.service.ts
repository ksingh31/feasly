import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  BuilderAuthLogoutResponse,
  BuilderAuthMeResponse,
  BuilderAuthRequestBody,
  BuilderAuthRequestResponse,
  BuilderAuthVerifyResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

import type {
  BuilderEntraCallbackBody,
  BuilderEntraCallbackResponse,
  BuilderMembershipsResponse,
  BuilderSessionIdentity,
  BuilderSwitchOrgBody,
  BuilderSwitchOrgResponse,
} from './builder-auth.contracts';

/**
 * Builder auth API client (embed/09, auth/05).
 *
 * Speaks the versioned `/api/v1/builder/auth/*` routes. auth/05 replaces
 * the magic-link flow with Microsoft Entra External ID (same tenant/user
 * flow as admin, AUTH-02): the SPA redirects to the Microsoft-hosted
 * authorize endpoint and the callback page exchanges the code here.
 * Credential flow is handled centrally by `credentialsInterceptor`
 * (ADM-10): every builder API request carries `Authorization: Bearer
 * <token>` from BuilderState (plus `withCredentials` for the same-origin
 * cookie fallback) — the cross-origin session cookie never sticks on
 * modern browsers, so the bearer token is the primary session credential.
 *
 * The builder portal is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock builder session).
 */
@Injectable({ providedIn: 'root' })
export class BuilderAuthApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private get authBase(): string {
    return `${this.base}/builder/auth`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Request a magic link. Always returns `{ sent: true }` (no oracle). */
  requestMagicLink(body: BuilderAuthRequestBody): Observable<BuilderAuthRequestResponse> {
    return this.call(
      this.http.post<BuilderAuthRequestResponse>(`${this.authBase}/request`, body, {
        withCredentials: true,
      }),
    );
  }

  /** Verify a magic-link token from the email. Returns the session token. */
  verifyMagicLink(token: string): Observable<BuilderAuthVerifyResponse> {
    return this.call(
      this.http.get<BuilderAuthVerifyResponse>(`${this.authBase}/verify`, {
        params: { token },
        withCredentials: true,
      }),
    );
  }

  /** Log out: revoke the session server-side. */
  logout(): Observable<BuilderAuthLogoutResponse> {
    return this.call(
      this.http.post<BuilderAuthLogoutResponse>(
        `${this.authBase}/logout`,
        {},
        { withCredentials: true },
      ),
    );
  }

  /**
   * Probe the current session. Emits the identity on success; the 401
   * propagates (UNAUTHENTICATED or SESSION_EXPIRED) so the builder route
   * guard can show the right login copy.
   *
   * auth/05: carries the session's org context (active builder, role,
   * memberships) — the shell renders the org switcher and team nav from
   * it. Display only; the backend stays authoritative. Fields are null
   * until the backend enriches `/me`; the UI treats missing org context
   * as "no org chosen yet".
   */
  me(): Observable<BuilderSessionIdentity> {
    return this.call(
      this.http
        .get<BuilderAuthMeResponse>(`${this.authBase}/me`, {
          withCredentials: true,
        })
        .pipe(
          map(
            (response): BuilderSessionIdentity => ({
              authenticated: true,
              email: response.email,
              name: null,
              builderId: response.tenantKey,
              builderName: null,
              role: null,
              memberships: [],
            }),
          ),
        ),
    );
  }

  // ------------------------------------------------------------------
  // auth/05 (builder org accounts) — Microsoft Entra External ID.
  //
  // CONTRACT-DRIVEN: `POST /api/v1/builder/auth/entra/callback` and the
  // org endpoints land with the backend half of auth/05. This client codes
  // against the frontend-owned placeholders in `builder-auth.contracts`
  // — the backend must honor those shapes.
  // ------------------------------------------------------------------

  /**
   * Exchange an Entra authorization code for our session. The SPA never
   * touches Entra tokens: the backend redeems `{ code, codeVerifier,
   * redirectUri }` with Entra, resolves the user's builder memberships,
   * and returns the Feasly session (`sessionToken` + user + memberships)
   * in the JSON body. A user with no membership gets a 403 (no
   * enumeration).
   */
  exchangeEntraCode(
    body: BuilderEntraCallbackBody,
  ): Observable<BuilderEntraCallbackResponse> {
    return this.call(
      this.http.post<BuilderEntraCallbackResponse>(
        `${this.authBase}/entra/callback`,
        body,
        { withCredentials: true },
      ),
    );
  }

  /** List the signed-in user's builder memberships. */
  listMemberships(): Observable<BuilderMembershipsResponse> {
    return this.call(
      this.http.get<BuilderMembershipsResponse>(`${this.authBase}/memberships`, {
        withCredentials: true,
      }),
    );
  }

  /**
   * Set the session's active org. The choice is stored server-side in the
   * session — never trusted from request params. The caller re-probes
   * /me afterwards to refresh the shell.
   */
  switchOrg(body: BuilderSwitchOrgBody): Observable<BuilderSwitchOrgResponse> {
    return this.call(
      this.http.post<BuilderSwitchOrgResponse>(
        `${this.authBase}/switch-org`,
        body,
        { withCredentials: true },
      ),
    );
  }
}
