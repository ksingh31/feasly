import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { CommissionInvoice } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Paginated invoice list — normalized wire shape for
 * `GET /api/v1/billing/invoices` (BILL-04).
 *
 * `total` is null when the backend does not report a count (the live
 * endpoint returns a bare array with limit/offset pagination); the UI
 * degrades gracefully to prev/next without "of N pages".
 */
export interface InvoiceListResponse {
  readonly invoices: readonly CommissionInvoice[];
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Builder invoices API client (BILL-04).
 *
 * Speaks the versioned `/api/v1/billing/invoices` routes behind the builder
 * session cookie (`withCredentials: true`). Every call is tenant-scoped
 * server-side; a builder can only ever see their own tenant's invoices.
 *
 * Not wired to the mock API — the builder portal always talks to the real
 * backend.
 */
@Injectable({ providedIn: 'root' })
export class BuilderInvoicesApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get billingBase(): string {
    const v1 = `${this.config.get('api').baseUrl}/api/v1`;
    return `${v1}/billing`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /**
   * Paginated invoice list, newest first. Speaks the backend's limit/offset
   * shape and normalizes the bare-array response (total unknown → null).
   */
  listInvoices(page: number, pageSize: number): Observable<InvoiceListResponse> {
    const offset = (page - 1) * pageSize;
    return this.call(
      this.http.get<readonly CommissionInvoice[]>(
        `${this.billingBase}/invoices`,
        {
          params: { limit: String(pageSize), offset: String(offset) },
          withCredentials: true,
        },
      ),
    ).pipe(
      // Normalize the bare array; the endpoint reports no total.
      // (rxjs `map` is imported via the pipe below.)
      map((invoices) => ({ invoices, total: null, page, pageSize })),
    );
  }

  /** Single invoice detail. */
  getInvoice(id: string): Observable<CommissionInvoice> {
    return this.call(
      this.http.get<CommissionInvoice>(`${this.billingBase}/invoices/${id}`, {
        withCredentials: true,
      }),
    );
  }
}
