import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminAuthRequestBody,
  AdminAuthRequestResponse,
  AdminAuthLogoutResponse,
  AdminAuthVerifyResponse,
  AdminEntraCallbackBody,
  AdminEntraCallbackResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin auth API client (admin/01).
 *
 * Speaks the versioned `/api/v1/admin/auth/*` routes. Credential flow is
 * handled centrally by `credentialsInterceptor` (ADM-10): every admin API
 * request carries `Authorization: Bearer <token>` from AdminAuthState (plus
 * `withCredentials` for the same-origin cookie fallback) — the
 * cross-origin session cookie never sticks on modern browsers, so the
 * bearer token is the primary session credential.
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminAuthApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private get authBase(): string {
    return `${this.base}/admin/auth`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Request a magic link. Always returns `{ sent: true }` (no oracle). */
  requestMagicLink(body: AdminAuthRequestBody): Observable<AdminAuthRequestResponse> {
    return this.call(
      this.http.post<AdminAuthRequestResponse>(`${this.authBase}/request`, body),
    );
  }

  /** Verify a magic-link token from the email. Returns the session token. */
  verifyMagicLink(token: string): Observable<AdminAuthVerifyResponse> {
    return this.call(
      this.http.get<AdminAuthVerifyResponse>(`${this.authBase}/verify`, {
        params: { token },
      }),
    );
  }

  /** Log out: revoke the session server-side. */
  logout(): Observable<AdminAuthLogoutResponse> {
    return this.call(
      this.http.post<AdminAuthLogoutResponse>(`${this.authBase}/logout`, {}),
    );
  }

  // ------------------------------------------------------------------
  // AUTH-02 (auth modernization, MVP) — Microsoft Entra External ID.
  //
  // CONTRACT-DRIVEN: `POST /api/v1/admin/auth/entra/callback` lands with
  // the backend half of auth/02. This method codes against
  // `AdminEntraCallbackBody` / `AdminEntraCallbackResponse` in
  // @feasly/contracts — the backend must honor that shape.
  // ------------------------------------------------------------------

  /**
   * Exchange an Entra authorization code for our session. The SPA never
   * touches Entra tokens: the backend redeems `{ code, codeVerifier,
   * redirectUri }` with Entra and returns the Feasly session
   * (`sessionToken` + user) in the JSON body — the same Bearer <redacted>
   * discipline as the magic-link verify response.
   */
  exchangeEntraCode(
    body: AdminEntraCallbackBody,
  ): Observable<AdminEntraCallbackResponse> {
    return this.call(
      this.http.post<AdminEntraCallbackResponse>(
        `${this.authBase}/entra/callback`,
        body,
      ),
    );
  }

  /**
   * Probe the current session. Emits the identity on success; the 401
   * propagates (UNAUTHENTICATED or SESSION_EXPIRED) so the admin route guard
   * can show the right login copy.
   */
  me(): Observable<{ email: string }> {
    return this.call(this.http.get<{ email: string }>(`${this.authBase}/me`));
  }
}
