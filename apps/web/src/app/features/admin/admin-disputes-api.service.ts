import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  DisputeDetailResponse,
  DisputeListItem,
  DisputeListResponse,
  ResolveDisputeRequest,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin dispute-console API client (billing/01 follow-on, was OPS-009).
 *
 * Speaks the versioned `/api/v1/admin/disputes/*` routes. All calls carry
 * `withCredentials: true` so the admin session authenticates cross-origin
 * (same pattern as the admin leads service).
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminDisputesApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /**
   * Versioned contract paths (short segments — the no-hardcode tripwire
   * flags string literals >= 50 chars, and these are API contract, not
   * tunables, so they don't belong in app-config.json).
   */
  private static readonly DISPUTES_PATH = '/api/v1/admin/disputes';
  private static readonly ACCEPT_SEGMENT = '/accept';
  private static readonly REJECT_SEGMENT = '/reject';

  private get disputesBase(): string {
    return this.config.get('api').baseUrl + AdminDisputesApiService.DISPUTES_PATH;
  }

  /** URL for a single dispute resource. */
  private disputeUrl(id: string): string {
    return this.disputesBase + '/' + encodeURIComponent(id);
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Open disputes, oldest first, each with its SLA countdown. */
  listDisputes(): Observable<DisputeListResponse> {
    return this.call(
      this.http.get<DisputeListResponse>(this.disputesBase, {
        withCredentials: true,
      }),
    );
  }

  /** Full dispute detail: immutable evidence snapshot + audit trail. */
  getDispute(id: string): Observable<DisputeDetailResponse> {
    return this.call(
      this.http.get<DisputeDetailResponse>(this.disputeUrl(id), {
        withCredentials: true,
      }),
    );
  }

  /**
   * Accept a dispute: voids the invoice (Stripe refund first when it was
   * already paid — the credit note). Audit-logged server-side.
   */
  acceptDispute(id: string, note?: string): Observable<DisputeListItem> {
    const body: ResolveDisputeRequest = note ? { note } : {};
    return this.call(
      this.http.post<DisputeListItem>(
        this.disputeUrl(id) + AdminDisputesApiService.ACCEPT_SEGMENT,
        body,
        { withCredentials: true },
      ),
    );
  }

  /**
   * Reject a dispute: the invoice returns to in_review with a fresh
   * 7-day window. Audit-logged server-side.
   */
  rejectDispute(id: string, note?: string): Observable<DisputeListItem> {
    const body: ResolveDisputeRequest = note ? { note } : {};
    return this.call(
      this.http.post<DisputeListItem>(
        this.disputeUrl(id) + AdminDisputesApiService.REJECT_SEGMENT,
        body,
        { withCredentials: true },
      ),
    );
  }
}
