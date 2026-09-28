import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AdminEstimateDetail, NarrativeResponse } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin estimate-lookup API client (admin/03).
 *
 * Speaks `GET /api/v1/admin/estimates/{id}`. All calls carry
 * `Authorization: Bearer <token>` (via the credentials interceptor) so the
 * admin session authenticates cross-origin. Read-only by construction —
 * this service exposes no mutation method (AC3).
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminEstimatesApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private get estimatesBase(): string {
    return `${this.base}/admin/estimates`;
  }

  /**
   * Fetch one estimate's read-only detail. Unknown IDs surface as
   * `ESTIMATE_NOT_FOUND` (AC2) via {@link toApiError}.
   */
  getEstimate(id: string): Observable<AdminEstimateDetail> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return this.http
      .get<AdminEstimateDetail>(
        `${this.estimatesBase}/${encodeURIComponent(id)}`,
        {
          withCredentials: true,
        },
      )
      .pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /**
   * Generate (or return cached) the AI narrative for an estimate.
   * Admin-gated top-up for estimates whose narrative was never generated
   * or failed (fix #287) — same pipeline as the consumer endpoint.
   */
  generateNarrative(id: string): Observable<NarrativeResponse> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return this.http
      .post<NarrativeResponse>(
        this.estimatesBase + '/' + encodeURIComponent(id) + '/narrative',
        {},
        {
          withCredentials: true,
        },
      )
      .pipe(timeout(timeoutMs), catchError(toApiError));
  }
}
