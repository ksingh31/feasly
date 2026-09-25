import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminAuthRequestBody,
  AdminAuthRequestResponse,
  AdminAuthLogoutResponse,
  AdminAuthVerifyResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin auth API client (admin/01).
 *
 * Speaks the versioned `/api/v1/admin/auth/*` routes. All calls use
 * `withCredentials: true` so the `feasly_admin_session` HttpOnly cookie is
 * sent on same-origin admin requests.
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
      this.http.post<AdminAuthRequestResponse>(`${this.authBase}/request`, body, {
        withCredentials: true,
      }),
    );
  }

  /** Verify a magic-link token from the email. Sets the session cookie. */
  verifyMagicLink(token: string): Observable<AdminAuthVerifyResponse> {
    return this.call(
      this.http.get<AdminAuthVerifyResponse>(`${this.authBase}/verify`, {
        params: { token },
        withCredentials: true,
      }),
    );
  }

  /** Log out: revoke the session and clear the cookie. */
  logout(): Observable<AdminAuthLogoutResponse> {
    return this.call(
      this.http.post<AdminAuthLogoutResponse>(
        `${this.authBase}/logout`,
        {},
        { withCredentials: true },
      ),
    );
  }

  /**
   * Probe the current session. Emits the identity on success; the 401
   * propagates (UNAUTHENTICATED or SESSION_EXPIRED) so the admin route guard
   * can show the right login copy.
   */
  me(): Observable<{ email: string }> {
    return this.call(
      this.http.get<{ email: string }>(`${this.authBase}/me`, { withCredentials: true }),
    );
  }
}
