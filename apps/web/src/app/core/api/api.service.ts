import { inject, InjectionToken } from '@angular/core';
import type { Provider } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AnalyticsEvent,
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
import { HttpApiService } from './http-api.service';
import { MockApiService } from './mock-api.service';

/**
 * The single seam between the UI and the backend (FE0-003).
 *
 * Every method mirrors one FE0-001 contract, returning RxJS Observables so
 * components can use the async pipe with takeUntilDestroyed. Components inject
 * {@link API_SERVICE} — they never know (or care) which implementation is
 * wired: there are no mock-only code paths in components.
 */
export interface ApiService {
  /** Address autocomplete. Short queries resolve to zero suggestions. */
  autocomplete(query: string): Observable<AutocompleteResponse>;
  /** City property record for an address key. Errors `not_found` when unknown. */
  getProperty(addressKey: string): Observable<PropertyRecord>;
  /** Pre-gate preview: every figure blurred, rows empty — by type. */
  getPreviewEstimate(
    request: EstimateRequest,
  ): Observable<PreviewEstimateResponse>;
  /** Post-gate estimate: real ranges. Only reachable after verification. */
  getEstimate(request: EstimateRequest): Observable<EstimateResponse>;
  /** Lead capture. The magic link travels by email in prod. */
  submitLead(request: LeadRequest): Observable<LeadResponse>;
  /** Resolves a magic-link token to a report token. */
  verifyMagicLink(token: string): Observable<MagicLinkVerifyResponse>;
  /** Re-sends the magic link. */
  reissueMagicLink(
    request: MagicLinkReissueRequest,
  ): Observable<MagicLinkReissueResponse>;
  /** Verified report snapshot for a report token. */
  getReport(reportToken: string): Observable<GetReportResponse>;
  /** Inline tier/sqft what-if: appends a new snapshot version. */
  reviseTier(
    reportToken: string,
    request: TierRevisionRequest,
  ): Observable<TierRevisionResponse>;
  /** Callback request from the report. */
  requestCallback(request: CallbackRequest): Observable<CallbackResponse>;
  /** Email the report to a partner (mints their own link). */
  shareWithPartner(
    request: PartnerShareRequest,
  ): Observable<PartnerShareResponse>;
  /** First-party analytics event. Fire-and-forget. */
  trackEvent(event: AnalyticsEvent): Observable<void>;
}

/** DI token for the ApiService. Inject this, never a concrete class. */
export const API_SERVICE = new InjectionToken<ApiService>('feasly.api-service');

/**
 * Wires the ApiService implementation from config: `api.useMockApi` selects
 * the mock harness (FE0-003). Flipping that flag is the ONLY change needed to
 * point at the real backend later — the HttpApiService already speaks the
 * /api/v1 routes. Call once in app.config.ts.
 */
export function provideApi(): Provider {
  return {
    provide: API_SERVICE,
    useFactory: () => {
      const config = inject(ConfigService);
      return config.get('api').useMockApi ? inject(MockApiService) : inject(HttpApiService);
    },
  };
}
