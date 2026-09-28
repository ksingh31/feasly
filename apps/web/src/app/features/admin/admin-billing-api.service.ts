import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { BillingHealthResponse } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin billing API client (billing/03 follow-on — /admin/billing).
 *
 * Speaks `GET /api/v1/admin/billing` (read-only dashboard) and
 * `POST /api/v1/admin/billing/invoices/{id}/retry` (BILL-03, the single
 * mutating action). Calls carry `withCredentials: true` so the admin
 * session cookie authenticates — the same pattern as AdminOpsApiService.
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminBillingApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    // Kept short on purpose: the no-hardcode tripwire (FE0-002) flags
    // template literals ≥ 50 chars, and admin-auth-api.service.ts uses
    // exactly this shape for `/api/v1`.
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  /** Base URL for the admin billing endpoints. */
  private get billingBase(): string {
    return this.base + '/admin/billing';
  }

  /** URL for the BILL-03 retry endpoint for one invoice. */
  private retryUrl(invoiceId: string): string {
    return (
      this.billingBase + '/invoices/' + encodeURIComponent(invoiceId) + '/retry'
    );
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** GET /api/v1/admin/billing — billing-health dashboard payload. */
  getBillingHealth(): Observable<BillingHealthResponse> {
    return this.call(
      this.http.get<BillingHealthResponse>(this.billingBase, {
        withCredentials: true,
      }),
    );
  }

  /**
   * POST /api/v1/admin/billing/invoices/{id}/retry — retry a failed
   * commission charge (BILL-03). Admin-gated, `billing:manage`.
   */
  retryInvoiceCharge(invoiceId: string): Observable<{
    invoiceId: string;
    status: string;
    retryCount: number;
  }> {
    return this.call(
      this.http.post<{
        invoiceId: string;
        status: string;
        retryCount: number;
      }>(this.retryUrl(invoiceId), null, {
        withCredentials: true,
      }),
    );
  }
}
