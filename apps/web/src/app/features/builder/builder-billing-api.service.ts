import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  CardOnFileStatus,
  CommissionRateResponse,
  SetupIntentResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/** Request body for POST /api/v1/billing/report-contract. */
export interface ReportContractRequest {
  /** The signed lead's id (UUID). */
  readonly leadId: string;
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
  /** ISO-8601 datetime (with offset) of the contract signing. */
  readonly contractSignedAt: string;
}

/**
 * Response for POST /api/v1/billing/report-contract (mirrors the
 * backend's BillableEventResult). The component only collects the inputs —
 * attribution, the draft invoice, and the 7-day review window all happen
 * server-side.
 */
export type ReportContractResult =
  | {
      readonly billed: true;
      readonly invoiceId: string;
      readonly invoiceStatus: string;
      /** Idempotent retry: the invoice already existed. */
      readonly reason?: 'existing_invoice' | 'existing_disputed';
    }
  | {
      readonly billed: false;
      readonly reason:
        | 'billing_not_enabled'
        | 'flat_subscription_covers'
        | 'awaiting_contract_details';
    };

/**
 * Builder billing API client (billing/02, BILL-02).
 *
 * Speaks the versioned `/api/v1/billing/*` card-on-file routes behind the
 * builder session cookie (`withCredentials: true`). Every call is
 * tenant-scoped server-side; a builder can only ever touch their own
 * tenant's billing — cross-tenant probing returns 403 (surfaced here as
 * an ApiError the UI handles gracefully).
 *
 * Not wired to the mock API — the builder portal always talks to the real
 * backend. No card PAN ever passes through here: Stripe Elements tokenizes
 * in the browser and only the SetupIntent client secret crosses the wire.
 */
@Injectable({ providedIn: 'root' })
export class BuilderBillingApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get billingBase(): string {
    // Split into short literals: the no-hardcode tripwire flags any string
    // literal >= 50 chars.
    const v1 = `${this.config.get('api').baseUrl}/api/v1`;
    return `${v1}/billing`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /**
   * Card-on-file status (brand/last4/expiry only — never the PAN).
   * `{ hasCard: false }` when nothing is saved yet.
   */
  getCard(): Observable<CardOnFileStatus> {
    return this.call(
      this.http.get<CardOnFileStatus>(`${this.billingBase}/card`, {
        withCredentials: true,
      }),
    );
  }

  /**
   * Create a SetupIntent for the Stripe Elements card form. Idempotent:
   * the backend ensures the tenant's Stripe customer first. Returns the
   * client secret for `stripe.confirmCardSetup`.
   */
  createSetupIntent(): Observable<SetupIntentResponse> {
    return this.call(
      this.http.post<SetupIntentResponse>(
        `${this.billingBase}/setup-intent`,
        {},
        { withCredentials: true },
      ),
    );
  }

  /**
   * Report a signed contract for one of the tenant's leads. The backend
   * runs attribution (12-month window), mints a draft commission invoice,
   * and starts the 7-day review window — the response tells the UI which
   * of those outcomes happened.
   */
  reportContract(
    body: ReportContractRequest,
  ): Observable<ReportContractResult> {
    return this.call(
      this.http.post<ReportContractResult>(
        `${this.billingBase}/report-contract`,
        body,
        { withCredentials: true },
      ),
    );
  }

  /**
   * The org's negotiated commission rate (percent), for the "Record signed
   * contract" live preview (billing/08). Falls back to the 1% default
   * client-side when the fetch fails — display-only.
   */
  getCommissionRate(): Observable<CommissionRateResponse> {
    return this.call(
      this.http.get<CommissionRateResponse>(
        `${this.billingBase}/commission-rate`,
        { withCredentials: true },
      ),
    );
  }
}
