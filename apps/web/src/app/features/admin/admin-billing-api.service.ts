import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminSetInvoicePaymentMethodResponse,
  BillingHealthResponse,
  BuilderPaymentMethod,
  CorrectContractRequest,
  CorrectContractResponse,
  ManualInvoiceRequest,
  ManualInvoiceResponse,
  ManualPaymentMethod,
  MarkInvoicePaidRequest,
  MarkInvoicePaidResponse,
  RefundInvoiceRequest,
  RefundInvoiceResponse,
  ReverseManualPaymentRequest,
  ReverseManualPaymentResponse,
  SetCommissionRateResponse,
  SimulatedInvoiceEventRequest,
  SimulatedInvoiceEventResponse,
  UpdateInvoiceDunningRequest,
  UpdateInvoiceDunningResponse,
  VoidInvoiceRequest,
  VoidInvoiceResponse,
} from '@feasly/contracts';
import { BUILDER_PAYMENT_METHODS } from '../builder/builder-payment-methods';
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
 * - `POST …/invoices/{id}/refund`, `/void`, `/correct-contract`,
 *   `/reverse-payment` (#715/#862 — refunds, voids, contract
 *   corrections and manual-payment reversals)
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
   * POST /api/v1/admin/billing/invoices/{id}/dunning (#718/#901) — pause,
   * resume or cancel an invoice's automatic retries, or set its grace
   * days. Admin-gated, `billing:manage`; audited server-side.
   */
  updateInvoiceDunning(
    invoiceId: string,
    body: UpdateInvoiceDunningRequest,
  ): Observable<UpdateInvoiceDunningResponse> {
    return this.call(
      this.http.post<UpdateInvoiceDunningResponse>(
        this.billingBase + '/invoices/' + encodeURIComponent(invoiceId) + '/dunning',
        body,
        { withCredentials: true },
      ),
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

  /** URL for one admin invoice action (`…/invoices/{id}/<action>`). */
  private invoiceActionUrl(invoiceId: string, action: string): string {
    return this.billingBase + '/invoices/' + encodeURIComponent(invoiceId) + '/' + action;
  }

  /**
   * POST /api/v1/admin/billing/invoices/{id}/refund (#715) — refund a paid
   * invoice in full (omit `amountCents`) or in part. Retrying with the same
   * `idempotencyKey` replays the first result: never a second refund.
   */
  refundInvoice(invoiceId: string, body: RefundInvoiceRequest): Observable<RefundInvoiceResponse> {
    return this.call(
      this.http.post<RefundInvoiceResponse>(this.invoiceActionUrl(invoiceId, 'refund'), body, {
        withCredentials: true,
      }),
    );
  }

  /** POST /api/v1/admin/billing/invoices/{id}/void (#715) — draft, in review or failed only. */
  voidInvoice(invoiceId: string, body: VoidInvoiceRequest): Observable<VoidInvoiceResponse> {
    return this.call(
      this.http.post<VoidInvoiceResponse>(this.invoiceActionUrl(invoiceId, 'void'), body, {
        withCredentials: true,
      }),
    );
  }

  /**
   * POST /api/v1/admin/billing/invoices/{id}/correct-contract (#715) — fix
   * the reported contract before the invoice is charged (draft, in review).
   * The server recalculates commission and tax.
   */
  correctContract(invoiceId: string, body: CorrectContractRequest): Observable<CorrectContractResponse> {
    return this.call(
      this.http.post<CorrectContractResponse>(this.invoiceActionUrl(invoiceId, 'correct-contract'), body, {
        withCredentials: true,
      }),
    );
  }

  /**
   * POST /api/v1/admin/billing/invoices/{id}/reverse-payment (#715) — undo
   * a manual mark-paid (the money never arrived). The invoice moves to
   * failed; nothing is auto-charged.
   */
  reversePayment(
    invoiceId: string,
    body: ReverseManualPaymentRequest,
  ): Observable<ReverseManualPaymentResponse> {
    return this.call(
      this.http.post<ReverseManualPaymentResponse>(this.invoiceActionUrl(invoiceId, 'reverse-payment'), body, {
        withCredentials: true,
      }),
    );
  }

  /**
   * PUT /api/v1/admin/billing/invoices/{id}/payment-method — change the
   * planned payment method on one commission invoice (card, cheque,
   * e_transfer, bank_draft). Admin-gated, `billing:manage`. Unpaid
   * invoices only; choosing a manual method pauses the Stripe
   * auto-charge until staff marks the invoice paid.
   */
  setInvoicePaymentMethod(
    invoiceId: string,
    method: BuilderPaymentMethod,
  ): Observable<AdminSetInvoicePaymentMethodResponse> {
    return this.call(
      this.http.put<AdminSetInvoicePaymentMethodResponse>(
        this.billingBase + '/invoices/' + encodeURIComponent(invoiceId) +
          '/payment-method',
        { method },
        { withCredentials: true },
      ),
    );
  }

  /**
   * POST /api/v1/admin/billing/simulated/invoices/{id}/events (#753/#791)
   * — the admin dev panel fires a dispute, a dashboard refund (optional
   * partial `amountCents`) or a delayed failure against the invoice's
   * simulated PaymentIntent. 404 unless the simulated provider is active;
   * 409 when the action does not apply to the invoice.
   */
  fireSimulatedInvoiceEvent(
    invoiceId: string,
    body: SimulatedInvoiceEventRequest,
  ): Observable<SimulatedInvoiceEventResponse> {
    return this.call(
      this.http.post<SimulatedInvoiceEventResponse>(
        this.billingBase + '/simulated/invoices/' + encodeURIComponent(invoiceId) +
          '/events',
        body,
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

/**
 * Planned payment-method labels for the admin manage-invoice modal and
 * the admin builder form. Plain admin copy (not the builder portal's
 * buyer-grade copy): derived from the shared BUILDER_PAYMENT_METHODS
 * list so a future method shows up everywhere without a second edit.
 */
const PLANNED_PAYMENT_METHOD_LABEL_MAP: Record<BuilderPaymentMethod, string> =
  {
    card: 'Card on file (auto-charge)',
    cheque: 'Cheque',
    e_transfer: 'E-transfer',
    bank_draft: 'Bank draft',
  };

export const PLANNED_PAYMENT_METHOD_LABELS: ReadonlyArray<{
  value: BuilderPaymentMethod;
  label: string;
}> = BUILDER_PAYMENT_METHODS.map((value) => ({
  value,
  label: PLANNED_PAYMENT_METHOD_LABEL_MAP[value],
}));
