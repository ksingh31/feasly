import { inject, InjectionToken, Injector } from '@angular/core';
import type { Provider } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AnalyticsEvent,
  AnyEstimateRequest,
  ApiKeyIssueRequest,
  ApiKeyIssuedResponse,
  ApiKeyListResponse,
  ApiKeyRecordResponse,
  ApiKeyScope,
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
  NarrativeResponse,
  PartnerShareRequest,
  PartnerShareResponse,
  PreviewEstimateResponse,
  EstimateResponse,
  ComparisonEstimateRequest,
  ComparisonEstimateResponse,
  PropertyRecord,
  TierRevisionRequest,
  TierRevisionResponse,
} from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import { HttpApiService } from './http-api.service';
import { MockApiService } from './mock-api.service';

/**
 * Community stats for one Calgary community (NBH-01 / NBH-03).
 * Mirrors the backend's snake_case `CommunityStatsResponse` — the frontend
 * does not rename the wire shape.
 */
export interface CommunityStats {
  readonly slug: string;
  readonly name: string;
  /** Whole CAD dollars — City-assessed value (not market value). */
  readonly avg_assessed_value: number;
  readonly assessment_count: number;
  readonly avg_lot_sqft: number | null;
  readonly refreshed_at: string;
  readonly stale: boolean;
}

/**
 * The single seam between the UI and the backend (FE0-003).
 *
 * Every method mirrors one FE0-001 contract, returning RxJS Observables so
 * components can use the async pipe with takeUntilDestroyed. Components inject
 * {@link API_SERVICE} — they never know (or care) which implementation is
 * wired. The one deliberate exception is the optional `devTokenForLead` hook:
 * it is implemented only by the mock, and components treat `undefined`
 * (the real backend) as the honest "check your email" path, never as a
 * shortcut around verification.
 */
export interface ApiService {
  /** Address autocomplete. Short queries resolve to zero suggestions. */
  autocomplete(query: string): Observable<AutocompleteResponse>;
  /** City property record for an address key. Errors `not_found` when unknown. */
  getProperty(addressKey: string): Observable<PropertyRecord>;
  /** Pre-gate preview: every figure blurred, rows empty — by type. */
  getPreviewEstimate(
    request: AnyEstimateRequest,
  ): Observable<PreviewEstimateResponse>;
  /** Post-gate estimate: real ranges. Only reachable after verification. */
  getEstimate(request: AnyEstimateRequest): Observable<EstimateResponse>;
  /**
   * Neighbourhood comparison estimate (NBH-02 / NBH-03): one row-set per
   * community with real ranges. The API returns full figures; clients blur
   * build/total until the lead gate converts (`EstimateVisibility` documents
   * the per-figure hints). Land stays visible pre-gate.
   */
  getComparisonEstimate(
    request: ComparisonEstimateRequest,
  ): Observable<ComparisonEstimateResponse>;
  /**
   * Community stats (NBH-01 / NBH-03): real average City-assessed value per
   * community. Errors `not_found` when the slug is unknown.
   */
  getCommunityStats(slug: string): Observable<CommunityStats>;
  /** Lead capture. The magic link travels by email in prod. */
  submitLead(request: LeadRequest): Observable<LeadResponse>;
  /** Resolves a magic-link token to a report token. */
  verifyMagicLink(token: string): Observable<MagicLinkVerifyResponse>;
  /**
   * DEV ONLY unlock: the report token the mock issued for a lead, so the
   * analyzing screen can complete the same-session unlock without an email
   * round-trip. OPTIONAL — only the mock implements it. The production
   * implementation MUST NOT: in production the magic-link email is the only
   * unlock path, and this must return undefined. Components treat `undefined`
   * as "check your email" and land the user on the locked report.
   */
  devTokenForLead?(leadId: string): string | undefined;
  /** Re-sends the magic link. */
  reissueMagicLink(
    request: MagicLinkReissueRequest,
  ): Observable<MagicLinkReissueResponse>;
  /** Verified report snapshot for a report token. */
  getReport(reportToken: string): Observable<GetReportResponse>;
  /**
   * AI narrative for an estimate (consumer/06): POST
   * /api/v1/estimates/{estimateId}/narrative, authenticated with the
   * magic-link Bearer token. The state calls this only when the snapshot
   * arrived with an empty narrative; failures leave the snapshot as-is so
   * the page shows the honest empty state, never mock text.
   */
  getNarrative(estimateId: string, reportToken: string): Observable<NarrativeResponse>;
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
  /** Admin: list API keys (masked prefixes only). */
  listApiKeys(): Observable<ApiKeyListResponse>;
  /** Admin: issue a new API key (plaintext returned once). */
  issueApiKey(request: ApiKeyIssueRequest): Observable<ApiKeyIssuedResponse>;
  /** Admin: rotate a key (new plaintext once, old revoked). */
  rotateApiKey(id: string): Observable<ApiKeyIssuedResponse>;
  /** Admin: revoke a key immediately. */
  revokeApiKey(id: string): Observable<{ readonly revoked: boolean }>;
  /** Admin: update a key's scopes / rate limit (takes effect next request). */
  updateApiKey(id: string, patch: ApiKeyUpdatePatch): Observable<ApiKeyRecordResponse>;
  /** Admin: per-day usage aggregates for a key. */
  getApiKeyUsage(keyId: string): Observable<readonly ApiKeyUsageAggregate[]>;
}

/** Per-day usage aggregate for an API key (api-mcp/07). */
export interface ApiKeyUsageAggregate {
  readonly date: string;
  readonly endpoint: string;
  readonly count: number;
  readonly estimates_created: number;
}

/** Patch for updating an API key's scopes / rate limit (api-mcp/02). */
export interface ApiKeyUpdatePatch {
  readonly scopes?: readonly ApiKeyScope[];
  readonly rate_limit_per_min?: number;
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

  getPreviewEstimate(request: AnyEstimateRequest): Observable<PreviewEstimateResponse> {
    return this.resolve().getPreviewEstimate(request);
  }

  getEstimate(request: AnyEstimateRequest): Observable<EstimateResponse> {
    return this.resolve().getEstimate(request);
  }

  getComparisonEstimate(
    request: ComparisonEstimateRequest,
  ): Observable<ComparisonEstimateResponse> {
    return this.resolve().getComparisonEstimate(request);
  }

  getCommunityStats(slug: string): Observable<CommunityStats> {
    return this.resolve().getCommunityStats(slug);
  }

  submitLead(request: LeadRequest): Observable<LeadResponse> {
    return this.resolve().submitLead(request);
  }

  verifyMagicLink(token: string): Observable<MagicLinkVerifyResponse> {
    return this.resolve().verifyMagicLink(token);
  }

  devTokenForLead(leadId: string): string | undefined {
    return this.resolve().devTokenForLead?.(leadId);
  }

  reissueMagicLink(request: MagicLinkReissueRequest): Observable<MagicLinkReissueResponse> {
    return this.resolve().reissueMagicLink(request);
  }

  getReport(reportToken: string): Observable<GetReportResponse> {
    return this.resolve().getReport(reportToken);
  }

  getNarrative(estimateId: string, reportToken: string): Observable<NarrativeResponse> {
    return this.resolve().getNarrative(estimateId, reportToken);
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

  listApiKeys(): Observable<ApiKeyListResponse> {
    return this.resolve().listApiKeys();
  }

  issueApiKey(request: ApiKeyIssueRequest): Observable<ApiKeyIssuedResponse> {
    return this.resolve().issueApiKey(request);
  }

  rotateApiKey(id: string): Observable<ApiKeyIssuedResponse> {
    return this.resolve().rotateApiKey(id);
  }

  revokeApiKey(id: string): Observable<{ readonly revoked: boolean }> {
    return this.resolve().revokeApiKey(id);
  }

  updateApiKey(id: string, patch: ApiKeyUpdatePatch): Observable<ApiKeyRecordResponse> {
    return this.resolve().updateApiKey(id, patch);
  }

  getApiKeyUsage(keyId: string): Observable<readonly ApiKeyUsageAggregate[]> {
    return this.resolve().getApiKeyUsage(keyId);
  }
}
