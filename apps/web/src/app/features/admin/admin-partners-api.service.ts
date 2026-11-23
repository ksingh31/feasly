import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminBuilderPartner,
  AdminBuilderPartnerListResponse,
  BuilderPartnerCreateBody,
  BuilderPartnerUpdateBody,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin builder-partner API client (#919, on the #896 admin CRUD API).
 *
 * `GET /api/v1/admin/partners` (list, active and inactive, display order),
 * `POST` (add) and `PATCH /{id}` (edit, activate/deactivate, reorder via
 * `displayOrder`). There is no delete — partners are turned off instead.
 * Every call carries `withCredentials` so the admin session cookie rides
 * along cross-origin, like the other admin API services.
 */
@Injectable({ providedIn: 'root' })
export class AdminPartnersApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /** Versioned contract path (API contract, not a tunable). */
  private static readonly PARTNERS_PATH = '/api/v1/admin/partners';

  private get base(): string {
    return this.config.get('api').baseUrl + AdminPartnersApiService.PARTNERS_PATH;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Every partner, active and inactive, in display order. */
  listPartners(): Observable<AdminBuilderPartnerListResponse> {
    return this.call(
      this.http.get<AdminBuilderPartnerListResponse>(this.base, { withCredentials: true }),
    );
  }

  /** Add a partner (defaults: active, after the current last partner). */
  createPartner(body: BuilderPartnerCreateBody): Observable<AdminBuilderPartner> {
    return this.call(
      this.http.post<AdminBuilderPartner>(this.base, body, { withCredentials: true }),
    );
  }

  /** Edit, activate/deactivate or reorder one partner. */
  updatePartner(id: string, body: BuilderPartnerUpdateBody): Observable<AdminBuilderPartner> {
    return this.call(
      this.http.patch<AdminBuilderPartner>(`${this.base}/${encodeURIComponent(id)}`, body, {
        withCredentials: true,
      }),
    );
  }
}
