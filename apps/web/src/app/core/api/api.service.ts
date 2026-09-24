import { inject, InjectionToken, Injector } from '@angular/core';
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
 * point the estimate/lead/magic-link contracts at the real backend — the
 * HttpApiService already speaks the /api/v1 routes. Property data
 * (autocomplete + records) has its own switch: `propertyData.source`
 * (see `providePropertyData()`). Call once in app.config.ts.
 */
export function provideApi(): Provider {
  return {
    provide: API_SERVICE,
    // The implementation is chosen per CALL, not when this factory runs — the
    // same early-injection hazard as providePropertyData(): NGXS v22
    // instantiates states in an *environment* initializer, before
    // APP_INITIALIZERs, so an eager read of `api.useMockApi` would freeze the
    // compiled default. (Invisible today because default and served config
    // agree on `true`, but a flipped served flag would have been silently
    // ignored.) Calls happen after bootstrap, so the loaded config is honored.
    useFactory: () => new LazyApiService(),
  };
}

/** Defers the ApiService implementation choice to call time (see above). */
class LazyApiService implements ApiService {
  private readonly injector = inject(Injector);

  private resolve(): ApiService {
    const useMock = this.injector.get(ConfigService).get('api').useMockApi;
    return useMock ? this.injector.get(MockApiService) : this.injector.get(HttpApiService);
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    return this.resolve().autocomplete(query);
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    return this.resolve().getProperty(addressKey);
  }

  getPreviewEstimate(request: EstimateRequest): Observable<PreviewEstimateResponse> {
    return this.resolve().getPreviewEstimate(request);
  }

  getEstimate(request: EstimateRequest): Observable<EstimateResponse> {
    return this.resolve().getEstimate(request);
  }

  submitLead(request: LeadRequest): Observable<LeadResponse> {
    return this.resolve().submitLead(request);
  }

  verifyMagicLink(token: string): Observable<MagicLinkVerifyResponse> {
    return this.resolve().verifyMagicLink(token);
  }

  reissueMagicLink(request: MagicLinkReissueRequest): Observable<MagicLinkReissueResponse> {
    return this.resolve().reissueMagicLink(request);
  }

  getReport(reportToken: string): Observable<GetReportResponse> {
    return this.resolve().getReport(reportToken);
  }

  reviseTier(reportToken: string, request: TierRevisionRequest): Observable<TierRevisionResponse> {
    return this.resolve().reviseTier(reportToken, request);
  }

  requestCallback(request: CallbackRequest): Observable<CallbackResponse> {
    return this.resolve().requestCallback(request);
  }

  shareWithPartner(request: PartnerShareRequest): Observable<PartnerShareResponse> {
    return this.resolve().shareWithPartner(request);
  }

  trackEvent(event: AnalyticsEvent): Observable<void> {
    return this.resolve().trackEvent(event);
  }
}
