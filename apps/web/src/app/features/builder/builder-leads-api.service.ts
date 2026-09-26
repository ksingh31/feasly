import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  BuilderLeadListResponse,
  BuilderLeadStatus,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Builder leads API client (embed/09).
 *
 * Speaks the versioned `/api/v1/builder/leads` routes behind the builder
 * session cookie (`withCredentials: true`). Every read and write is
 * tenant-scoped server-side; a builder can only ever see their own
 * tenant's leads — cross-tenant probing returns 403 (surfaced here as an
 * ApiError the UI handles gracefully).
 *
 * Not wired to the mock API — the builder portal always talks to the real
 * backend.
 */
@Injectable({ providedIn: 'root' })
export class BuilderLeadsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get leadsBase(): string {
    return `${this.config.get('api').baseUrl}/api/v1/builder/leads`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Tenant-scoped lead list + pipeline summary. */
  listLeads(): Observable<BuilderLeadListResponse> {
    return this.call(
      this.http.get<BuilderLeadListResponse>(this.leadsBase, { withCredentials: true }),
    );
  }

  /**
   * Update a lead's pipeline status. Emits `{ ok: true }` on success; a
   * 403 means the lead belongs to another tenant (backend-enforced).
   */
  updateStatus(id: string, status: BuilderLeadStatus): Observable<{ ok: true }> {
    return this.call(
      this.http.patch<{ ok: true }>(
        `${this.leadsBase}/${encodeURIComponent(id)}`,
        { status },
        { withCredentials: true },
      ),
    );
  }
}
