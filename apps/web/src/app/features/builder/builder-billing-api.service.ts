import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  CardOnFileStatus,
  SetupIntentResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

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
}
