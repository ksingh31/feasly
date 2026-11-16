import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  Builder,
  BuilderCreateBody,
  BuilderExportKind,
  BuilderLifecycleBody,
  BuilderLifecycleResponse,
  BuilderListResponse,
  BuilderOffboardingBlockersResponse,
  BuilderUpdateBody,
  LeadAssignBuilderBody,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError, toBlobApiError } from '../../core/api/api-error';

/**
 * Admin builders-management API client (embed/02 admin-UI migration).
 *
 * Speaks the versioned `/api/v1/admin/builders/*` routes plus the
 * `POST /api/v1/admin/leads/{id}/assign-builder` endpoint. All calls carry
 * `withCredentials: true` so the admin session cookie authenticates
 * cross-origin (same pattern as the admin leads service).
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminBuildersApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /**
   * Versioned contract paths (short segments — the no-hardcode tripwire
   * flags string literals >= 50 chars, and these are API contract, not
   * tunables, so they don't belong in app-config.json).
   */
  private static readonly BUILDERS_PATH = '/api/v1/admin/builders';
  private static readonly LEADS_PATH = '/api/v1/admin/leads';
  private static readonly ASSIGN_BUILDER_SEGMENT = '/assign-builder';
  private static readonly STATUS_SEGMENT = '/status';
  private static readonly BLOCKERS_SEGMENT = '/offboarding-blockers';
  private static readonly EXPORT_SEGMENT = '/export.csv';

  private get buildersBase(): string {
    return this.config.get('api').baseUrl + AdminBuildersApiService.BUILDERS_PATH;
  }

  private get leadsBase(): string {
    return this.config.get('api').baseUrl + AdminBuildersApiService.LEADS_PATH;
  }

  /** URL for a single builder resource. */
  private builderUrl(id: string): string {
    return this.buildersBase + '/' + encodeURIComponent(id);
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** All builders (the builders table — runtime source of truth for builder config). */
  listBuilders(): Observable<BuilderListResponse> {
    return this.call(
      this.http.get<BuilderListResponse>(this.buildersBase, {
        withCredentials: true,
      }),
    );
  }

  /** A single builder row. */
  getBuilder(id: string): Observable<Builder> {
    return this.call(
      this.http.get<Builder>(this.builderUrl(id), {
        withCredentials: true,
      }),
    );
  }

  /** Create a builder row. `tenantKey` is immutable after creation. */
  createBuilder(body: BuilderCreateBody): Observable<Builder> {
    return this.call(
      this.http.post<Builder>(this.buildersBase, body, {
        withCredentials: true,
      }),
    );
  }

  /** Update a builder row (`tenantKey` cannot change — it is not accepted here). */
  updateBuilder(id: string, body: BuilderUpdateBody): Observable<Builder> {
    return this.call(
      this.http.patch<Builder>(this.builderUrl(id), body, {
        withCredentials: true,
      }),
    );
  }

  /**
   * Lifecycle action (#860/#861): suspend · reactivate · start or complete
   * offboarding, with a mandatory reason. 409 OFFBOARDING_BLOCKED while an
   * invoice is unpaid or a dispute is open.
   */
  changeStatus(id: string, body: BuilderLifecycleBody): Observable<BuilderLifecycleResponse> {
    return this.call(
      this.http.post<BuilderLifecycleResponse>(
        this.builderUrl(id) + AdminBuildersApiService.STATUS_SEGMENT,
        body,
        { withCredentials: true },
      ),
    );
  }

  /** What blocks "complete offboarding" right now (#861 checklist). */
  offboardingBlockers(id: string): Observable<BuilderOffboardingBlockersResponse> {
    return this.call(
      this.http.get<BuilderOffboardingBlockersResponse>(
        this.builderUrl(id) + AdminBuildersApiService.BLOCKERS_SEGMENT,
        { withCredentials: true },
      ),
    );
  }

  /**
   * One builder's leads or invoices as CSV (#860 hand-over export). Fetched
   * as a blob (cookie auth can't ride a plain navigation) with the bulk
   * export timeout and blob-aware error mapping (same as the leads export).
   */
  exportCsv(id: string, kind: BuilderExportKind): Observable<Blob> {
    return this.http
      .get(this.builderUrl(id) + AdminBuildersApiService.EXPORT_SEGMENT, {
        params: { kind },
        withCredentials: true,
        responseType: 'blob',
      })
      .pipe(timeout(this.config.get('api').exportTimeoutMs), catchError(toBlobApiError));
  }

  /**
   * Assign a lead to a builder (`builderId: null` unassigns). The backend
   * writes the lead row + audit trail; the caller refetches the lead
   * detail for the updated `builderId`.
   */
  assignLeadBuilder(leadId: string, builderId: string | null): Observable<{ ok: true }> {
    const body: LeadAssignBuilderBody = { builderId };
    return this.call(
      this.http.post<{ ok: true }>(
        this.leadsBase +
          '/' +
          encodeURIComponent(leadId) +
          AdminBuildersApiService.ASSIGN_BUILDER_SEGMENT,
        body,
        { withCredentials: true },
      ),
    );
  }
}
