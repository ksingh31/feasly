import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { CommissionInvoice } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';
import type { BuilderPaymentMethod } from './builder-payment-methods';

/**
 * Commission invoice with the billing/12 payment-method fields. The
 * backend includes `invoiceNumber` + `paymentMethod` on the invoice list
 * and detail endpoints; new invoices inherit the builder's default
 * payment method at creation.
 */
export interface BuilderCommissionInvoice extends CommissionInvoice {
  /** Human-readable invoice number, e.g. "INV-0042". */
  readonly invoiceNumber: string;
  /** How this invoice will be paid (card auto-charge or manual). */
  readonly paymentMethod: BuilderPaymentMethod;
}

/**
 * Paginated invoice list — normalized wire shape for
 * `GET /api/v1/billing/invoices` (BILL-04).
 *
 * `total` is null when the backend does not report a count (the live
 * endpoint returns a bare array with limit/offset pagination); the UI
 * degrades gracefully to prev/next without "of N pages".
 */
export interface InvoiceListResponse {
  readonly invoices: readonly BuilderCommissionInvoice[];
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
   *
   * Params are clamped to the backend's contract (limit 1–100, offset ≥ 0)
   * so a bad caller can never produce a 400 from the zod validation.
   * `invoiceNumber` is an optional case-insensitive partial match on the
   * human-readable invoice number (e.g. "42" matches "INV-0042").
   */
  listInvoices(
    page: number,
    pageSize: number,
    invoiceNumber?: string,
  ): Observable<InvoiceListResponse> {
    const safePage = Number.isFinite(page)
      ? Math.max(1, Math.floor(page))
      : 1;
    const safePageSize = Number.isFinite(pageSize)
      ? Math.min(100, Math.max(1, Math.floor(pageSize)))
      : 20;
    const offset = (safePage - 1) * safePageSize;
    const params: Record<string, string> = {
      limit: String(safePageSize),
      offset: String(offset),
    };
    const trimmed = invoiceNumber?.trim();
    if (trimmed) {
      params['invoiceNumber'] = trimmed;
    }
    return this.call(
      this.http.get<readonly BuilderCommissionInvoice[]>(
        `${this.billingBase}/invoices`,
        {
          params,
          withCredentials: true,
        },
      ),
    ).pipe(
      // Normalize the bare array; the endpoint reports no total.
      // (rxjs `map` is imported via the pipe below.)
      map((invoices) => ({
        invoices,
        total: null,
        page: safePage,
        pageSize: safePageSize,
      })),
    );
  }

  /** Single invoice detail. */
  getInvoice(id: string): Observable<BuilderCommissionInvoice> {
    return this.call(
      this.http.get<BuilderCommissionInvoice>(
        `${this.billingBase}/invoices/${id}`,
        {
          withCredentials: true,
        },
      ),
    );
  }

  /**
   * Change an invoice's payment method (billing/12). Returns the updated
   * invoice. Choosing a manual method pauses the scheduled Stripe
   * auto-charge until staff confirm the payment.
   */
  setInvoicePaymentMethod(
    id: string,
    method: BuilderPaymentMethod,
  ): Observable<BuilderCommissionInvoice> {
    return this.call(
      this.http.put<BuilderCommissionInvoice>(
        `${this.billingBase}/invoices/${id}/payment-method`,
        { method },
        { withCredentials: true },
      ),
    );
  }
}
