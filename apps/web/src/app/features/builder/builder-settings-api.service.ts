import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  BuilderAccountClosureBody,
  BuilderAccountClosureResponse,
  BuilderEmbedResponse,
  BuilderNotificationPreferencesResponse,
  BuilderNotificationPreferencesUpdateBody,
  BuilderOriginRequestBody,
  BuilderOriginRequestResponse,
  BuilderProfileResponse,
  BuilderProfileUpdateBody,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Builder Settings API client (#871, web half of #724; API in #870).
 *
 * - `GET/PUT /api/v1/builder/profile` — profile & branding + support contact.
 * - `GET /api/v1/builder/embed` — install snippet, read-only allowed
 *   origins with a per-origin install check.
 * - `POST /api/v1/builder/embed/origin-requests` — "Request a change".
 * - `GET/PUT /api/v1/builder/notifications/preferences` — the signed-in
 *   member's email preferences (#864; API in #725). `PUT` → 409
 *   LAST_ADMIN for the last billing admin, 403 while viewing as a teammate.
 * - `POST /api/v1/builder/account/close-request` — "Close my account"
 *   (#861; one admin task, no self-serve deletion).
 *
 * Org-scoped server-side (the session's builder); writes are owner-only
 * and refused while viewing as a teammate — the UI mirrors `canEdit`.
 */
@Injectable({ providedIn: 'root' })
export class BuilderSettingsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1/builder`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  getProfile(): Observable<BuilderProfileResponse> {
    return this.call(
      this.http.get<BuilderProfileResponse>(`${this.base}/profile`, { withCredentials: true }),
    );
  }

  updateProfile(body: BuilderProfileUpdateBody): Observable<BuilderProfileResponse> {
    return this.call(
      this.http.put<BuilderProfileResponse>(`${this.base}/profile`, body, {
        withCredentials: true,
      }),
    );
  }

  getEmbed(): Observable<BuilderEmbedResponse> {
    return this.call(
      this.http.get<BuilderEmbedResponse>(`${this.base}/embed`, { withCredentials: true }),
    );
  }

  requestOriginChange(body: BuilderOriginRequestBody): Observable<BuilderOriginRequestResponse> {
    return this.call(
      this.http.post<BuilderOriginRequestResponse>(
        `${this.base}/embed/origin-requests`,
        body,
        { withCredentials: true },
      ),
    );
  }

  getNotificationPreferences(): Observable<BuilderNotificationPreferencesResponse> {
    return this.call(
      this.http.get<BuilderNotificationPreferencesResponse>(
        `${this.base}/notifications/preferences`,
        { withCredentials: true },
      ),
    );
  }

  updateNotificationPreferences(
    body: BuilderNotificationPreferencesUpdateBody,
  ): Observable<BuilderNotificationPreferencesResponse> {
    return this.call(
      this.http.put<BuilderNotificationPreferencesResponse>(
        `${this.base}/notifications/preferences`,
        body,
        { withCredentials: true },
      ),
    );
  }

  requestAccountClosure(body: BuilderAccountClosureBody): Observable<BuilderAccountClosureResponse> {
    return this.call(
      this.http.post<BuilderAccountClosureResponse>(`${this.base}/account/close-request`, body, {
        withCredentials: true,
      }),
    );
  }
}
