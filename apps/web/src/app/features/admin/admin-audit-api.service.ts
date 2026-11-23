import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AuditLogListQuery, AuditLogListResponse } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin audit-log client (#728 API) — `GET /api/v1/admin/audit`, the
 * merged admin + billing trail. Used by the invoice drawer (#862) to show
 * refunds, voids, contract corrections and payment reversals.
 *
 * Calls carry `withCredentials: true` so the admin session authenticates.
 */
@Injectable({ providedIn: 'root' })
export class AdminAuditApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /** Versioned contract path (API contract, not a tunable). */
  private static readonly AUDIT_PATH = '/api/v1/admin/audit';

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** One page of audit entries, newest first. */
  list(query: AuditLogListQuery): Observable<AuditLogListResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
    }
    return this.call(
      this.http.get<AuditLogListResponse>(this.config.get('api').baseUrl + AdminAuditApiService.AUDIT_PATH, {
        params,
        withCredentials: true,
      }),
    );
  }
}
