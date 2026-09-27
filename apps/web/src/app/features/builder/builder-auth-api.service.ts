import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
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

/**
 * Builder auth API client (embed/09). Mirrors the admin/01 client.
 *
 * Speaks the versioned `/api/v1/builder/auth/*` routes. Credential flow is
 * handled centrally by `credentialsInterceptor` (ADM-10): every builder API
 * request carries `Authorization: Bearer <token>` from BuilderState (plus
 * `withCredentials` for the same-origin cookie fallback) — the
 * cross-origin session cookie never sticks on modern browsers, so the
 * bearer token is the primary session credential.
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
   */
  me(): Observable<BuilderAuthMeResponse> {
    return this.call(
      this.http.get<BuilderAuthMeResponse>(`${this.authBase}/me`, { withCredentials: true }),
    );
  }
}
