import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  SheetsSyncNowResponse,
  SheetsSyncStatusResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin ops API client (admin/05).
 *
 * Speaks the versioned `/api/v1/admin/ops/sheets-*` routes. All calls use
 * `withCredentials: true` so the `feasly_admin_session` HttpOnly cookie is
 * sent on same-origin admin requests — the same pattern as
 * AdminAuthApiService.
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminOpsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    // Kept short on purpose: the no-hardcode tripwire (FE0-002) flags
    // template literals ≥ 50 chars, and admin-auth-api.service.ts uses
    // exactly this shape for `/api/v1`.
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** GET /api/v1/admin/ops/sheets-status — worker health at a glance. */
  getSheetsStatus(): Observable<SheetsSyncStatusResponse> {
    return this.call(
      this.http.get<SheetsSyncStatusResponse>(`${this.base}/admin/ops/sheets-status`, {
        withCredentials: true,
      }),
    );
  }

  /**
   * POST /api/v1/admin/ops/sheets-sync-now — triggers exactly one worker
   * run inline, audit-logged server-side with the admin's email. Emits 409
   * when a run is already in flight.
   */
  triggerSheetsSyncNow(): Observable<SheetsSyncNowResponse> {
    return this.call(
      this.http.post<SheetsSyncNowResponse>(
        `${this.base}/admin/ops/sheets-sync-now`,
        {},
        { withCredentials: true },
      ),
    );
  }
}
