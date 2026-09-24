import { inject, Injectable } from '@angular/core';
import { map, of } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AnalyticsEvent,
  ApiError,
  AutocompleteResponse,
  CallbackRequest,
  CallbackResponse,
  EstimateInputs,
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
import { simulateLatency } from './latency';
import {
  MOCK_TIER_FACTORS,
  MOCK_VERIFY_FAILURE,
  mockCallbackOk,
  mockEstimate,
  mockLeadResponse,
  mockPreviewEstimate,
  mockPropertyFor,
  mockReport,
  mockShareOk,
  mockSuggestions,
  mockVerifySuccess,
  scaleRange,
} from './mock-data';

/**
 * Mock API harness (FE0-003): implements every FE0-001 contract with fixture
 * data so the wizard, analyzing beat, blur behavior, and gate flow run
 * exactly as they will against the real API.
 *
 * - Latency window from ConfigService (`timings.mockLatency*Ms`).
 * - The analyzing beat is just latency + the preview endpoint — same as prod.
 * - `submitLead` mints a `mock-<uuid>` token (the `?mock-token=` dev flow);
 *   `verifyMagicLink` resolves tokens this instance issued.
 * - Pre-gate responses are typed `PreviewEstimateResponse`: a leak is a
 *   compile error, and the conformance spec asserts it at runtime too.
 */
@Injectable({ providedIn: 'root' })
export class MockApiService implements ApiService {
  private readonly config = inject(ConfigService);

  /** Tokens this instance issued: token → { estimateId, leadId }. */
  private readonly issuedTokens = new Map<string, { estimateId: string; leadId: string }>();
  /** Inputs per estimate, so report/tier-revision stay consistent. */
  private readonly estimateInputs = new Map<string, EstimateInputs>();
  /** Report versions per estimate, so tier revisions increment monotonically. */
  private readonly reportVersions = new Map<string, number>();

  /** Inputs when no estimate was run first (e.g. a bare report link). */
  private defaultInputs(): EstimateInputs {
    return {
      sqft: this.config.get('wizard').sqftDefault,
      tier: 'premium',
      garage: 'double',
      basement: 'unfinished',
    };
  }

  /** Drops the address key: the estimate math only needs the inputs. */
  private toInputs(request: EstimateRequest): EstimateInputs {
    return {
      sqft: request.sqft,
      tier: request.tier,
      garage: request.garage,
      basement: request.basement,
    };
  }

  /** Simulates one network round trip using the configured mock latency. */
  private roundTrip<T>(value: T): Observable<T> {
    const timings = this.config.get('timings');
    return simulateLatency(timings.mockLatencyMinMs, timings.mockLatencyMaxMs).pipe(
      map(() => value),
    );
  }

  private roundTripError(error: ApiError): Observable<never> {
    const timings = this.config.get('timings');
    return simulateLatency(timings.mockLatencyMinMs, timings.mockLatencyMaxMs).pipe(
      map(() => {
        throw error;
      }),
    );
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    const q = query.trim().toLowerCase();
    const suggestions =
      q.length < 3
        ? []
        : mockSuggestions()
            .filter((s) => s.address.toLowerCase().includes(q))
            .slice(0, 6);
    return this.roundTrip({ suggestions });
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    const property = mockPropertyFor(addressKey);
    if (!property) {
      return this.roundTripError({
        code: 'not_found',
        message: 'No City record for that address yet.',
        retryable: false,
      });
    }
    return this.roundTrip(property);
  }

  getPreviewEstimate(request: EstimateRequest): Observable<PreviewEstimateResponse> {
    const inputs = this.toInputs(request);
    const response = mockPreviewEstimate(inputs);
    this.estimateInputs.set(response.estimateId, inputs);
    return this.roundTrip(response);
  }

  getEstimate(request: EstimateRequest): Observable<EstimateResponse> {
    const inputs = this.toInputs(request);
    const response = mockEstimate(inputs);
    this.estimateInputs.set(response.estimateId, inputs);
    return this.roundTrip(response);
  }

  submitLead(request: LeadRequest): Observable<LeadResponse> {
    const leadId = `lead-mock-${crypto.randomUUID()}`;
    const token = `mock-${crypto.randomUUID()}`;
    this.issuedTokens.set(token, { estimateId: request.estimateId, leadId });
    return this.roundTrip(mockLeadResponse(leadId));
  }

  /**
   * DEV ONLY helper (not on the ApiService interface — components can't see
   * it): the token the mock "emailed" for a lead, for the `?mock-token=` flow.
   */
  devMagicLinkForLead(leadId: string): string | undefined {
    for (const [token, ids] of this.issuedTokens) {
      if (ids.leadId === leadId) return token;
    }
    return undefined;
  }

  verifyMagicLink(token: string): Observable<MagicLinkVerifyResponse> {
    const ids = this.issuedTokens.get(token);
    const response = ids
      ? mockVerifySuccess(token, ids.estimateId, ids.leadId)
      : MOCK_VERIFY_FAILURE;
    return this.roundTrip(response);
  }

  reissueMagicLink(request: MagicLinkReissueRequest): Observable<MagicLinkReissueResponse> {
    void request;
    return this.roundTrip({ sent: true });
  }

  getReport(reportToken: string): Observable<GetReportResponse> {
    const ids = this.issuedTokens.get(reportToken);
    if (!ids) {
      return this.roundTripError({
        code: 'not_found',
        message: 'That report link is not valid.',
        retryable: false,
      });
    }
    const inputs = this.estimateInputs.get(ids.estimateId) ?? this.defaultInputs();
    const disclaimer = this.config.get('copy').narrativeDisclaimer;
    const version = this.reportVersions.get(ids.estimateId) ?? 1;
    return this.roundTrip({ ...mockReport(ids.estimateId, ids.leadId, inputs, disclaimer), version });
  }

  reviseTier(
    reportToken: string,
    request: TierRevisionRequest,
  ): Observable<TierRevisionResponse> {
    const ids = this.issuedTokens.get(reportToken);
    if (!ids) {
      return this.roundTripError({
        code: 'not_found',
        message: 'That report link is not valid.',
        retryable: false,
      });
    }
    const current = this.estimateInputs.get(ids.estimateId) ?? this.defaultInputs();
    const next: EstimateInputs = {
      ...current,
      tier: request.tier ?? current.tier,
      sqft: request.sqft ?? current.sqft,
    };
    const tierFactor = MOCK_TIER_FACTORS[next.tier] / MOCK_TIER_FACTORS[current.tier];
    const sqftFactor = next.sqft / current.sqft;
    const factor = tierFactor * sqftFactor;
    const base = mockEstimate(current);
    const revised = mockReport(
      ids.estimateId,
      ids.leadId,
      next,
      this.config.get('copy').narrativeDisclaimer,
    );
    this.estimateInputs.set(ids.estimateId, next);
    const version = (this.reportVersions.get(ids.estimateId) ?? 1) + 1;
    this.reportVersions.set(ids.estimateId, version);
    return this.roundTrip({
      ...revised,
      buildRange: scaleRange(base.figures.build, factor),
      totalRange: scaleRange(base.figures.total, factor),
      landRange: scaleRange(base.figures.land, factor),
      rows: base.rows.map((row) => ({ ...row, range: scaleRange(row.range, factor) })),
      version,
    });
  }

  requestCallback(request: CallbackRequest): Observable<CallbackResponse> {
    return this.roundTrip(mockCallbackOk(request.window));
  }

  shareWithPartner(request: PartnerShareRequest): Observable<PartnerShareResponse> {
    return this.roundTrip(mockShareOk(request.partnerEmail));
  }

  trackEvent(event: AnalyticsEvent): Observable<void> {
    void event;
    return of(undefined);
  }
}
