import { HttpHeaders, HttpParams } from '@angular/common/http';
import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, switchMap, throwError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AnalyticsEvent,
  AnyEstimateRequest,
  ApiKeyIssueRequest,
  ApiKeyIssuedResponse,
  ApiKeyListResponse,
  ApiKeyRecordResponse,
  AutocompleteResponse,
  BuilderPartnerListResponse,
  CallbackRequest,
  CallbackResponse,
  WaitlistRequest,
  WaitlistResponse,
  CityDataFreshnessResponse,
  CommunityLivingResponse,
  CommunitySchoolDesignationsResponse,
  SchoolsListResponse,
  CommunityMatchRequest,
  AddressSchoolDesignationsResponse,
  CommunityCompareResponse,
  CommunityLivingResponse,
  CommunityMatchResponse,
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
  PartnerShareVerifyResponse,
  PreviewEstimateResponse,
  EstimateResponse,
  ComparisonEstimateRequest,
  ComparisonEstimateResponse,
  PropertyRecord,
  TierRevisionRequest,
  TierRevisionResponse,
  UnsubscribePreferencesInput,
  ErasureConfirmResponse,
  ErasureRequestResponse,
  PrivacyExportResponse,
  UnsubscribeResultResponse,
  UnsubscribeStateResponse,
} from '@feasly/contracts';
import { BOT_CHALLENGE_HEADER } from '@feasly/contracts';
import type { FunnelQuery, FunnelReport } from './funnel.types';
import { ConfigService } from '../config/config.service';
import type { ApiKeyUpdatePatch, ApiKeyUsageAggregate, ApiService, CommunityStats } from './api.service';
import { challengeSiteKey, toApiError } from './api-error';
import { TurnstileChallengeService } from './turnstile-challenge.service';
import { PROPERTY_DATA_SERVICE } from './property-data.service';

/**
 * Real backend client (FE0-003): speaks the versioned `/api/v1` routes with
 * the FE0-001 contract types. Selected by `provideApi()` when
 * `api.useMockApi` is false — flipping that flag is the only change needed
 * to point at the live backend.
 *
 * Property data (autocomplete + records) delegates to PROPERTY_DATA_SERVICE
 * (FE1-002): our /api/v1 property routes by default (#752), the live City
 * API only when `propertyData.source` is 'live' (local dev). Route shapes here are the client's
 * proposal; the backend (BE-3+) implements the same contract DTOs, so any
 * route rename is a paired change.
 */
@Injectable({ providedIn: 'root' })
export class HttpApiService implements ApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);
  private readonly propertyData = inject(PROPERTY_DATA_SERVICE);
  private readonly botChallenge = inject(TurnstileChallengeService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private get adminBase(): string {
    return `${this.base}/admin/api-keys`;
  }

  private call<T>(request: Observable<T>, timeoutMs?: number): Observable<T> {
    const effectiveTimeoutMs = timeoutMs ?? this.config.get('api').timeoutMs;
    return request.pipe(timeout(effectiveTimeoutMs), catchError(toApiError));
  }

  /**
   * #905: like {@link call}, for the lead and estimate routes that may
   * answer 403 CHALLENGE_REQUIRED / CHALLENGE_FAILED (#788). On that 403
   * the invisible Turnstile challenge runs with the site key from the
   * response, then the request is retried exactly once with the token. If
   * the challenge can't complete, the original 403 surfaces; a failed retry
   * surfaces as-is. Each attempt gets its own timeout; the challenge has its
   * own (`botChallenge.timeoutMs`).
   */
  private callWithChallenge<T>(
    send: (headers?: HttpHeaders) => Observable<T>,
    timeoutMs?: number,
  ): Observable<T> {
    const effectiveTimeoutMs = timeoutMs ?? this.config.get('api').timeoutMs;
    return send().pipe(
      timeout(effectiveTimeoutMs),
      catchError((error: unknown) => {
        const siteKey = challengeSiteKey(error);
        if (siteKey === null) return throwError(() => error);
        return this.botChallenge.solve(siteKey).pipe(
          catchError(() => throwError(() => error)),
          switchMap((token) =>
            send(new HttpHeaders().set(BOT_CHALLENGE_HEADER, token)).pipe(
              timeout(effectiveTimeoutMs),
            ),
          ),
        );
      }),
      catchError(toApiError),
    );
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    return this.propertyData.autocomplete(query);
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    return this.propertyData.getProperty(addressKey);
  }

  getPreviewEstimate(request: AnyEstimateRequest): Observable<PreviewEstimateResponse> {
    return this.callWithChallenge((headers) =>
      this.http.post<PreviewEstimateResponse>(`${this.base}/estimates/preview`, request, {
        headers,
      }),
    );
  }

  /**
   * Post-gate estimate (new-build and renovation): POST /api/v1/estimate
   * (singular — the function adapter discriminates on `projectType`).
   */
  getEstimate(request: AnyEstimateRequest): Observable<EstimateResponse> {
    return this.callWithChallenge((headers) =>
      this.http.post<EstimateResponse>(`${this.base}/estimate`, request, { headers }),
    );
  }

  /**
   * Neighbourhood comparison (NBH-02): the real route is POST /api/v1/estimate
   * (singular) — the function adapter discriminates on `projectType`.
   */
  getComparisonEstimate(
    request: ComparisonEstimateRequest,
  ): Observable<ComparisonEstimateResponse> {
    return this.callWithChallenge((headers) =>
      this.http.post<ComparisonEstimateResponse>(`${this.base}/estimate`, request, { headers }),
    );
  }

  /** Community stats (NBH-01): GET /api/v1/communities/{slug}/stats. */
  getCommunityStats(slug: string): Observable<CommunityStats> {
    const path = `/communities/${encodeURIComponent(slug)}/stats`;
    return this.call(
      this.http.get<CommunityStats>(`${this.base}${path}`),
    );
  }

  /**
   * City-data freshness (trust-strip/01): GET /api/v1/city-data/freshness.
   * The backend never 500s this route — a null refreshedMonth is the
   * honest "unknown" answer, not an error.
   */
  getCityDataFreshness(): Observable<CityDataFreshnessResponse> {
    return this.call(
      this.http.get<CityDataFreshnessResponse>(`${this.base}/city-data/freshness`),
    );
  }

  /** Builder partner disclosure (#918): GET /api/v1/partners (public, cached). */
  getPartners(): Observable<BuilderPartnerListResponse> {
    return this.call(this.http.get<BuilderPartnerListResponse>(`${this.base}/partners`));
  }

  /** #781: GET /api/v1/communities/{slug}/school-designations (public, ungated). */
  getCommunitySchoolDesignations(slug: string): Observable<CommunitySchoolDesignationsResponse> {
    const community = `/communities/${encodeURIComponent(slug)}`;
    return this.call(
      this.http.get<CommunitySchoolDesignationsResponse>(`${this.base}${community}/school-designations`),
    );
  }

  /** #781: GET /api/v1/schools?community={code} (public, ungated). */
  listCommunitySchools(communityCode: string): Observable<SchoolsListResponse> {
    return this.call(
      this.http.get<SchoolsListResponse>(`${this.base}/schools`, {
        params: { community: communityCode },
      }),
    );
  }

  /** #781: GET /api/v1/communities/{slug}/living (public, ungated). */
  getCommunityLiving(slug: string): Observable<CommunityLivingResponse> {
    const path = `/communities/${encodeURIComponent(slug)}/living`;
    return this.call(this.http.get<CommunityLivingResponse>(`${this.base}${path}`));
  }

  /** Community match (#778): POST /api/v1/communities/match (public, ungated). */
  matchCommunities(request: CommunityMatchRequest): Observable<CommunityMatchResponse> {
    return this.call(
      this.http.post<CommunityMatchResponse>(`${this.base}/communities/match`, request),
    );
  }

  /** Community compare (#780): GET /api/v1/communities/compare?slugs= (public, ungated). */
  compareCommunities(slugs: readonly string[]): Observable<CommunityCompareResponse> {
    return this.call(
      this.http.get<CommunityCompareResponse>(`${this.base}/communities/compare`, {
        params: { slugs: slugs.join(',') },
      }),
    );
  }

  /** #785: GET /api/v1/school-designations?addressKey= (public, ungated). */
  getAddressSchoolDesignations(addressKey: string): Observable<AddressSchoolDesignationsResponse> {
    return this.call(
      this.http.get<AddressSchoolDesignationsResponse>(`${this.base}/school-designations`, {
        params: { addressKey },
      }),
    );
  }

  /** #785: GET /api/v1/communities/{slug}/living (public, ungated). */
  getCommunityLiving(slug: string): Observable<CommunityLivingResponse> {
    const path = `/communities/${encodeURIComponent(slug)}/living`;
    return this.call(this.http.get<CommunityLivingResponse>(`${this.base}${path}`));
  }

  submitLead(request: LeadRequest): Observable<LeadResponse> {
    // The gate submit waits on the synchronous email send (worst case ~20s
    // with in-code retries), so it uses the gate-specific timeout — the
    // global api.timeoutMs stays tight for every other call.
    return this.callWithChallenge(
      (headers) => this.http.post<LeadResponse>(`${this.base}/leads`, request, { headers }),
      this.config.get('api').gateTimeoutMs,
    );
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

  /**
   * AI narrative (consumer/06): POST /api/v1/estimates/{estimateId}/narrative.
   * Authenticated by the magic-link Bearer token — the same token that
   * unlocked the report (ReportState holds it memory-only). The response
   * carries the verbatim footer, so the caller renders it as-is.
   */
  getNarrative(estimateId: string, reportToken: string): Observable<NarrativeResponse> {
    const headers = new HttpHeaders().set('Authorization', `Bearer ${reportToken}`);
    const encoded = encodeURIComponent(estimateId);
    return this.call(
      this.http.post<NarrativeResponse>(
        `${this.base}/estimates/${encoded}/narrative`,
        {},
        { headers },
      ),
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

  joinWaitlist(request: WaitlistRequest): Observable<WaitlistResponse> {
    return this.call(this.http.post<WaitlistResponse>(`${this.base}/waitlist`, request));
  }

  shareWithPartner(request: PartnerShareRequest): Observable<PartnerShareResponse> {
    return this.call(this.http.post<PartnerShareResponse>(`${this.base}/shares`, request));
  }

  verifyPartnerShare(token: string): Observable<PartnerShareVerifyResponse> {
    const params = new HttpParams().set('token', token);
    return this.call(
      this.http.get<PartnerShareVerifyResponse>(`${this.base}/shares/verify`, { params }),
    );
  }

  /** #706: the magic-link token is the privacy endpoints' Bearer credential. */
  private bearer(reportToken: string): HttpHeaders {
    return new HttpHeaders().set('Authorization', `Bearer ${reportToken}`);
  }

  exportPrivacyData(reportToken: string): Observable<PrivacyExportResponse> {
    return this.call(
      this.http.get<PrivacyExportResponse>(`${this.base}/privacy/export`, {
        headers: this.bearer(reportToken),
      }),
    );
  }

  requestErasure(reportToken: string): Observable<ErasureRequestResponse> {
    return this.call(
      this.http.post<ErasureRequestResponse>(
        `${this.base}/privacy/erase-requests`,
        {},
        { headers: this.bearer(reportToken) },
      ),
    );
  }

  confirmErasure(reportToken: string, requestId: string): Observable<ErasureConfirmResponse> {
    const id = encodeURIComponent(requestId);
    const path = `/privacy/erase-requests/${id}/confirm`;
    return this.call(
      this.http.post<ErasureConfirmResponse>(
        `${this.base}${path}`,
        {},
        { headers: this.bearer(reportToken) },
      ),
    );
  }

  /** Token travels in the path (never logged); encoded like the backend's buildUnsubscribeUrl. */
  private unsubscribePath(token: string): string {
    return `/unsubscribe/${encodeURIComponent(token)}`;
  }

  getUnsubscribeState(token: string): Observable<UnsubscribeStateResponse> {
    return this.call(
      this.http.get<UnsubscribeStateResponse>(`${this.base}${this.unsubscribePath(token)}`),
    );
  }

  confirmUnsubscribe(token: string): Observable<UnsubscribeResultResponse> {
    return this.call(
      this.http.post<UnsubscribeResultResponse>(
        `${this.base}${this.unsubscribePath(token)}`,
        {},
      ),
    );
  }

  saveUnsubscribePreferences(
    token: string,
    prefs: UnsubscribePreferencesInput,
  ): Observable<UnsubscribeResultResponse> {
    return this.call(
      this.http.post<UnsubscribeResultResponse>(
        `${this.base}${this.unsubscribePath(token)}`,
        prefs,
      ),
    );
  }

  trackEvent(event: AnalyticsEvent): Observable<void> {
    return this.call(this.http.post<void>(`${this.base}/events`, event));
  }

  /**
   * Admin funnel report (admin/07).
   *
   * Admin session auth (admin/01) is the gate: `withCredentials: true` sends
   * the `feasly_admin_session` HttpOnly cookie automatically (same-origin) —
   * the same pattern as AdminOpsApiService. Session-cookie auth is the only
   * gate: the backend no longer honors any pre-shared-key header.
   */
  getFunnel(query: FunnelQuery): Observable<FunnelReport> {
    let params = new HttpParams();
    if (query.from) {
      params = params.set('from', query.from);
    }
    if (query.to) {
      params = params.set('to', query.to);
    }
    // 'all' = omit the param (backend treats absent as all; an empty string
    // would fail the min(1) validation).
    if (query.tenant !== 'all') {
      params = params.set('tenant_key', query.tenant);
    }
    // #815: exact-match campaign filters; omitted = any.
    if (query.utmSource) {
      params = params.set('utm_source', query.utmSource);
    }
    if (query.utmCampaign) {
      params = params.set('utm_campaign', query.utmCampaign);
    }
    return this.call(
      this.http.get<FunnelReport>(`${this.base}/admin/funnels`, {
        params,
        withCredentials: true,
      }),
    );
  }

  /**
   * Admin session auth (admin/01): the `feasly_admin_session` httpOnly cookie
   * rides on every API request via `credentialsInterceptor` — no per-call
   * header is needed or sent.
   */
  listApiKeys(): Observable<ApiKeyListResponse> {
    return this.call(this.http.get<ApiKeyListResponse>(this.adminBase));
  }

  issueApiKey(request: ApiKeyIssueRequest): Observable<ApiKeyIssuedResponse> {
    return this.call(
      this.http.post<ApiKeyIssuedResponse>(this.adminBase, request),
    );
  }

  rotateApiKey(id: string): Observable<ApiKeyIssuedResponse> {
    const path = `${this.adminBase}/${encodeURIComponent(id)}`;
    return this.call(
      this.http.post<ApiKeyIssuedResponse>(`${path}/rotate`, {}),
    );
  }

  revokeApiKey(id: string): Observable<{ readonly revoked: boolean }> {
    const path = `${this.adminBase}/${encodeURIComponent(id)}`;
    return this.call(
      this.http.post<{ readonly revoked: boolean }>(`${path}/revoke`, {}),
    );
  }

  updateApiKey(id: string, patch: ApiKeyUpdatePatch): Observable<ApiKeyRecordResponse> {
    const path = `${this.adminBase}/${encodeURIComponent(id)}`;
    return this.call(this.http.patch<ApiKeyRecordResponse>(path, patch));
  }

  getApiKeyUsage(keyId: string): Observable<readonly ApiKeyUsageAggregate[]> {
    return this.call(
      this.http.get<readonly ApiKeyUsageAggregate[]>(`${this.base}/admin/usage`, {
        params: { key_id: keyId },
      }),
    );
  }
}
