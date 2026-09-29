import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  BillingHealthResponse,
  ManualInvoiceRequest,
  ManualInvoiceResponse,
  ManualPaymentMethod,
  MarkInvoicePaidRequest,
  MarkInvoicePaidResponse,
  SetCommissionRateResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin billing API client (billing/03 follow-on — /admin/billing).
 *
 * Speaks `GET /api/v1/admin/billing` (read-only dashboard) and the admin
 * invoice actions:
 * - `POST /api/v1/admin/billing/invoices/{id}/retry` (BILL-03 charge retry)
 * - `POST /api/v1/admin/billing/invoices` (manual invoice creation)
 * - `POST /api/v1/admin/billing/invoices/{id}/mark-paid` (record an
 *   off-Stripe payment — cancels the scheduled auto-charge)
 * - `POST /api/v1/admin/billing/invoices/{id}/commission-rate`
 *   (per-invoice commission-rate override)
 *
 * Calls carry `withCredentials: true` so the admin session cookie
 * authenticates — the same pattern as AdminOpsApiService.
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

  /** URL for the manual-invoice creation endpoint. */
  private createInvoiceUrl(): string {
    return this.billingBase + '/invoices';
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

  /**
   * POST /api/v1/admin/billing/invoices/{id}/mark-paid — record an
   * off-Stripe payment for a commission invoice. Admin-gated,
   * `billing:manage`. Marks the invoice paid AND cancels the scheduled
   * auto-charge, so the builder can never be double-charged.
   */
  markInvoicePaid(
    invoiceId: string,
    body: MarkInvoicePaidRequest,
  ): Observable<MarkInvoicePaidResponse> {
    return this.call(
      this.http.post<MarkInvoicePaidResponse>(
        this.billingBase + '/invoices/' + encodeURIComponent(invoiceId) +
          '/mark-paid',
        body,
        { withCredentials: true },
      ),
    );
  }

  /**
   * POST /api/v1/admin/billing/invoices/{id}/commission-rate — override
   * the per-invoice commission rate (percent, e.g. 1.5 = 1.5%).
   * Admin-gated, `billing:manage`. Unpaid invoices only; the server
   * recalculates the commission from the signed contract value.
   */
  setCommissionRate(
    invoiceId: string,
    rate: number,
  ): Observable<SetCommissionRateResponse> {
    return this.call(
      this.http.post<SetCommissionRateResponse>(
        this.billingBase + '/invoices/' + encodeURIComponent(invoiceId) +
          '/commission-rate',
        { rate },
        { withCredentials: true },
      ),
    );
  }

  /**
   * POST /api/v1/admin/billing/invoices — manually create a commission
   * invoice for a builder's converted lead. Admin-gated, `billing:manage`.
   * The body mirrors the builder-reported contract shape
   * (ManualInvoiceRequest): leadId, integer cents EXCLUDING land, ISO
   * contractSignedAt with offset — plus tenantKey.
   */
  createManualInvoice(
    body: ManualInvoiceRequest,
  ): Observable<ManualInvoiceResponse> {
    return this.call(
      this.http.post<ManualInvoiceResponse>(this.createInvoiceUrl(), body, {
        withCredentials: true,
      }),
    );
  }
}

/** Payment-method labels shown in the mark-paid dropdown. */
export const MANUAL_PAYMENT_METHOD_LABELS: ReadonlyArray<{
  value: ManualPaymentMethod;
  label: string;
}> = [
  { value: 'cheque', label: 'Cheque' },
  { value: 'bank_draft', label: 'Bank draft' },
  { value: 'direct_deposit', label: 'Direct deposit' },
  { value: 'e_transfer', label: 'E-transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'visa', label: 'Visa' },
  { value: 'mastercard', label: 'Mastercard' },
  { value: 'card_terminal', label: 'Card terminal' },
  { value: 'other', label: 'Other' },
];
