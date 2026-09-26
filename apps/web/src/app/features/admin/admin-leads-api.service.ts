import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminLeadDetail,
  AdminLeadFilters,
  AdminLeadListResponse,
  AdminLeadMutationResponse,
  AdminLeadNoteRequest,
  AdminLeadStatus,
  AdminLeadStatusRequest,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin leads-explorer API client (admin/02).
 *
 * Speaks the versioned `/api/v1/admin/leads/*` routes. All calls use
 * `withCredentials: true` so the `feasly_admin_session` HttpOnly cookie is
 * sent (same pattern as the admin auth service).
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminLeadsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /**
   * Versioned contract paths (short segments — the no-hardcode tripwire
   * flags string literals >= 50 chars, and these are API contract, not
   * tunables, so they don't belong in app-config.json).
   */
  private static readonly LEADS_PATH = '/api/v1/admin/leads';
  private static readonly NOTES_SEGMENT = '/notes';
  private static readonly STATUS_SEGMENT = '/status';

  private get leadsBase(): string {
    return this.config.get('api').baseUrl + AdminLeadsApiService.LEADS_PATH;
  }

  /** URL for a single lead resource. */
  private leadUrl(id: string): string {
    return this.leadsBase + '/' + encodeURIComponent(id);
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /**
   * Builds the query params for the list/export endpoints.
   *
   * Every filter is optional; undefined values are omitted so the backend
   * defaults apply (e.g. limit 25, quarantined/sandbox excluded).
   */
  toQueryParams(
    filters: AdminLeadFilters,
    cursor?: string | null,
    limit?: number,
  ): HttpParams {
    let params = new HttpParams();
    const set = (key: string, value: string | number | boolean | undefined | null): void => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      params = params.set(key, String(value));
    };
    set('minScore', filters.minScore);
    set('maxScore', filters.maxScore);
    set('status', filters.status);
    set('source', filters.source);
    set('projectType', filters.projectType);
    set('tenantId', filters.tenantId);
    set('createdAfter', filters.createdAfter);
    set('createdBefore', filters.createdBefore);
    set('search', filters.search);
    set('includeQuarantined', filters.includeQuarantined);
    set('includeSandbox', filters.includeSandbox);
    set('cursor', cursor);
    set('limit', limit);
    return params;
  }

  /** Filtered lead list with cursor pagination. */
  listLeads(
    filters: AdminLeadFilters,
    cursor?: string | null,
    limit?: number,
  ): Observable<AdminLeadListResponse> {
    return this.call(
      this.http.get<AdminLeadListResponse>(this.leadsBase, {
        params: this.toQueryParams(filters, cursor, limit),
        withCredentials: true,
      }),
    );
  }

  /** Full lead detail (estimate summary, notes, history, consent). */
  getLead(id: string): Observable<AdminLeadDetail> {
    return this.call(
      this.http.get<AdminLeadDetail>(this.leadUrl(id), {
        withCredentials: true,
      }),
    );
  }

  /** Append a note (append-only — no edit/delete path exists). */
  addNote(id: string, note: string): Observable<AdminLeadMutationResponse> {
    const body: AdminLeadNoteRequest = { note };
    return this.call(
      this.http.post<AdminLeadMutationResponse>(
        this.leadUrl(id) + AdminLeadsApiService.NOTES_SEGMENT,
        body,
        { withCredentials: true },
      ),
    );
  }

  /** Transition pipeline status (writes lead_status_history + audit row). */
  updateStatus(id: string, status: AdminLeadStatus): Observable<AdminLeadMutationResponse> {
    const body: AdminLeadStatusRequest = { status };
    return this.call(
      this.http.patch<AdminLeadMutationResponse>(
        this.leadUrl(id) + AdminLeadsApiService.STATUS_SEGMENT,
        body,
        { withCredentials: true },
      ),
    );
  }

  /**
   * Download the CSV export of the filtered set.
   *
   * Fetched as a blob (cookie auth can't ride a plain navigation), then
   * handed to the caller to trigger the browser download.
   */
  exportCsv(filters: AdminLeadFilters): Observable<Blob> {
    return this.call(
      this.http.get(`${this.leadsBase}/export.csv`, {
        params: this.toQueryParams(filters),
        withCredentials: true,
        responseType: 'blob',
      }),
    );
  }
}
