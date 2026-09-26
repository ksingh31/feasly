import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AdminCalibrationResponse } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin calibration-console API client (admin/09).
 *
 * Speaks `GET /api/v1/admin/calibration`. All calls use
 * `withCredentials: true` so the `feasly_admin_session` HttpOnly cookie is
 * sent on same-origin admin requests.
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminCalibrationApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private get calibrationUrl(): string {
    return `${this.base}/admin/calibration`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Fetch the calibration console payload (read-only). */
  getCalibration(): Observable<AdminCalibrationResponse> {
    return this.call(
      this.http.get<AdminCalibrationResponse>(this.calibrationUrl, {
        withCredentials: true,
      }),
    );
  }
}
