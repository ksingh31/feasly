import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, throwError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AnalyticsEvent,
  ApiError,
  AutocompleteResponse,
  CallbackRequest,
  CallbackResponse,
  EstimateRequest,
  GetReportResponse,
  LeadRequest,
  LeadResponse,
  MagicLinkReissueRequest,
  MagicLinkReissueResponse,
  MagicLinkVerifyResponse,
  PartnerShareRequest,
  PartnerShareResponse,
  PreviewEstimateResponse,
  EstimateResponse,
  PropertyRecord,
  TierRevisionRequest,
  TierRevisionResponse,
} from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import type { ApiService } from './api.service';

/**
 * Maps an HTTP failure onto the contract ApiError envelope.
 * 5xx and network failures (status 0) are retryable; anything else isn't.
 */
function toApiError(error: unknown): Observable<never> {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ApiError> | undefined;
    return throwError((): ApiError => {
      const code = typeof body?.code === 'string' ? body.code : `http_${error.status}`;
      const message =
        typeof body?.message === 'string' && body.message.length > 0
          ? body.message
          : 'Request failed. Please try again.';
      const retryable =
        error.status === 0 || error.status >= HttpStatusCode.InternalServerError;
      return { code, message, retryable };
    });
  }
  return throwError(
    (): ApiError => ({ code: 'unknown', message: 'Request failed. Please try again.', retryable: false }),
  );
}

/**
 * Real backend client (FE0-003): speaks the versioned `/api/v1` routes with
 * the FE0-001 contract types. Selected by `provideApi()` when
 * `api.useMockApi` is false — flipping that flag is the only change needed
 * to point at the live backend.
 *
 * Route shapes here are the client's proposal; the backend (BE-3+) implements
 * the same contract DTOs, so any route rename is a paired change.
 */
@Injectable({ providedIn: 'root' })
export class HttpApiService implements ApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    return this.call(
      this.http.post<AutocompleteResponse>(`${this.base}/properties/autocomplete`, { query }),
    );
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    return this.call(this.http.get<PropertyRecord>(`${this.base}/properties/${addressKey}`));
  }

  getPreviewEstimate(request: EstimateRequest): Observable<PreviewEstimateResponse> {
    return this.call(
      this.http.post<PreviewEstimateResponse>(`${this.base}/estimates/preview`, request),
    );
  }

  getEstimate(request: EstimateRequest): Observable<EstimateResponse> {
    return this.call(this.http.post<EstimateResponse>(`${this.base}/estimates`, request));
  }

  submitLead(request: LeadRequest): Observable<LeadResponse> {
    return this.call(this.http.post<LeadResponse>(`${this.base}/leads`, request));
  }

  verifyMagicLink(token: string): Observable<MagicLinkVerifyResponse> {
    const params = new HttpParams().set('token', token);
    return this.call(
      this.http.get<MagicLinkVerifyResponse>(`${this.base}/magic-link/verify`, { params }),
    );
  }

  reissueMagicLink(request: MagicLinkReissueRequest): Observable<MagicLinkReissueResponse> {
    return this.call(
      this.http.post<MagicLinkReissueResponse>(`${this.base}/magic-link/reissue`, request),
    );
  }

  getReport(reportToken: string): Observable<GetReportResponse> {
    return this.call(
      this.http.get<GetReportResponse>(`${this.base}/reports/${reportToken}`),
    );
  }

  reviseTier(
    reportToken: string,
    request: TierRevisionRequest,
  ): Observable<TierRevisionResponse> {
    return this.call(
      this.http.post<TierRevisionResponse>(`${this.base}/reports/${reportToken}/revisions`, request),
    );
  }

  requestCallback(request: CallbackRequest): Observable<CallbackResponse> {
    return this.call(this.http.post<CallbackResponse>(`${this.base}/callbacks`, request));
  }

  shareWithPartner(request: PartnerShareRequest): Observable<PartnerShareResponse> {
    return this.call(this.http.post<PartnerShareResponse>(`${this.base}/shares`, request));
  }

  trackEvent(event: AnalyticsEvent): Observable<void> {
    return this.call(this.http.post<void>(`${this.base}/events`, event));
  }
}
