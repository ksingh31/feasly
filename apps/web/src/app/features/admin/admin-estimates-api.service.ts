import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AdminEstimateDetail } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin estimate-lookup API client (admin/03).
 *
 * Speaks `GET /api/v1/admin/estimates/{id}`. All calls use
 * `withCredentials: true` so the `feasly_admin_session` HttpOnly cookie is
 * sent on same-origin admin requests. Read-only by construction — this
 * service exposes no mutation method (AC3).
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
}
