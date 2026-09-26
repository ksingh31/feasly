import { inject, Injectable } from '@angular/core';
import { map, of } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AnalyticsEvent,
  AnyEstimateRequest,
  ApiError,
  AutocompleteResponse,
  CallbackRequest,
  CallbackResponse,
  ComparisonEstimateRequest,
  ComparisonEstimateResponse,
  EstimateInputs,
  GetReportResponse,
  LeadRequest,
  LeadResponse,
  MagicLinkReissueRequest,
  MagicLinkReissueResponse,
  MagicLinkVerifyResponse,
  NarrativeResponse,
  NewBuildEstimateRequest,
  PartnerShareRequest,
  PartnerShareResponse,
  PreviewEstimateResponse,
  EstimateResponse,
  PropertyRecord,
  RenoEstimateInputs,
  RenoEstimateRequest,
  TierRevisionRequest,
  TierRevisionResponse,
  UnsubscribeResultResponse,
  UnsubscribeStateResponse,
} from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import type { ApiService, CommunityStats } from './api.service';
import { simulateLatency } from './latency';
import {
  MOCK_VERIFY_FAILURE,
  mockCallbackOk,
  mockCommunityStats,
  mockComparisonEstimate,
  mockEstimate,
  mockLeadResponse,
  mockPreviewEstimate,
  mockPropertyFor,
  mockRenoEstimate,
  mockRenoReport,
  mockReport,
  mockShareOk,
  mockVerifySuccess,
} from './mock-data';
import { PROPERTY_DATA_SERVICE } from './property-data.service';

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
 * - Property data (autocomplete + records) delegates to PROPERTY_DATA_SERVICE
 *   (FE1-002): the fixture harness there, unless `propertyData.source` points
 *   at the live City API or our backend.
 */
@Injectable({ providedIn: 'root' })
export class MockApiService implements ApiService {
  private readonly config = inject(ConfigService);
  private readonly propertyData = inject(PROPERTY_DATA_SERVICE);

  /** Tokens this instance issued: token → { estimateId, leadId }. */
  private readonly issuedTokens = new Map<string, { estimateId: string; leadId: string }>();
  /** Unsubscribe tokens already opted out (email/03 dev harness). */
  private readonly unsubscribedTokens = new Set<string>();
  /** Inputs per estimate, so report/tier-revision stay consistent. */
  private readonly estimateInputs = new Map<string, EstimateInputs>();
  /** Reno inputs per estimate (RENO-04), so reno reports include renoInputs. */
  private readonly renoEstimateInputs = new Map<string, RenoEstimateInputs>();
  /** Report versions per estimate, so tier revisions increment monotonically. */
  private readonly reportVersions = new Map<string, number>();
  /**
   * Assessed land value per estimate (from the property record). The mock
   * mirrors the real backend, where land = the property's City assessed
   * value — not a canned fixture. Stored at estimate time so the report
   * and tier revisions reuse the same figure.
   */
  private readonly estimateLandValues = new Map<string, number>();
  /**
   * Assessed values by addressKey, captured from getProperty calls. The
   * wizard looks up the property when the user selects it, so the value
   * is available synchronously when the estimate is created.
   */
  private readonly propertyAssessedValues = new Map<string, number>();

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
  private toInputs(request: AnyEstimateRequest): EstimateInputs {
    // Reno requests carry renoSqft/tier; map to the legacy shape for preview.
    if (request.projectType === 'renovation') {
      return {
        sqft: request.renoSqft,
        tier: request.tier,
        garage: 'none',
        basement: 'unfinished',
      };
    }
    // Comparison requests (NBH-02) are backend-only; the mock preview does
    // not implement them. Narrow the type for the new_build branch below.
    if (request.projectType === 'comparison') {
      throw new Error('Comparison not supported in mock');
    }
    // New-build requests are nested { property, scope } (mirrors the live API).
    return {
      sqft: request.scope.buildSqft,
      tier: request.scope.tier,
      garage: request.scope.garage,
      basement: request.scope.basement,
    };
  }

  /** Address key regardless of request shape (new-build nests it under `property`). */
  private requestAddressKey(
    request: NewBuildEstimateRequest | RenoEstimateRequest,
  ): string {
    return request.projectType === 'renovation'
      ? request.addressKey
      : request.property.addressKey;
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
    return this.propertyData.autocomplete(query);
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    // Cache the assessed value so estimates/reports can use the property's
    // real assessment as the fixed land figure (mirrors the real backend).
    return this.propertyData.getProperty(addressKey).pipe(
      map((property) => {
        this.propertyAssessedValues.set(addressKey, property.assessedValue);
        return property;
      }),
    );
  }

  getPreviewEstimate(request: AnyEstimateRequest): Observable<PreviewEstimateResponse> {
    // Comparison (NBH-02) is backend-only; not supported in mock preview.
    if (request.projectType === 'comparison') {
      throw new Error('Comparison not supported in mock');
    }
    const inputs = this.toInputs(request);
    // Mirror the real backend: land is the property's City assessed value.
    // The mock property fixtures are synchronous; use the fixture's assessed
    // value when available. Falls back to the canned default for addresses
    // not in the fixtures (e.g. live City API data) — the preview never
    // blocks on this.
    const addressKey = this.requestAddressKey(request);
    const assessedLandValue =
      mockPropertyFor(addressKey)?.assessedValue ??
      this.propertyAssessedValues.get(addressKey);
    // Pre-gate preview carries the real computed figures — the UI renders
    // them blurred until the lead gate unlocks (2026-09-26).
    const response = mockPreviewEstimate(addressKey, inputs, {
      assessedLandValue,
      referenceSqft: this.referenceSqft(),
      renoRequest: request.projectType === 'renovation' ? request : undefined,
    });
    this.estimateInputs.set(response.estimateId, inputs);
    if (request.projectType === 'renovation') {
      // Recorded so getReport() resolves a reno snapshot for reno leads.
      // (The preview shape itself stays contract-clean: no renoInputs pre-gate.
      // The report keys pre-gate reno UI off WizardState.projectType instead.)
      const renoInputs: RenoEstimateInputs = {
        projectType: 'renovation',
        renoType: request.renoType,
        renoSqft: request.renoSqft,
        tier: request.tier,
        underpinning: request.underpinning ?? false,
      };
      this.renoEstimateInputs.set(response.estimateId, renoInputs);
    }
    if (assessedLandValue !== undefined) {
      this.estimateLandValues.set(response.estimateId, assessedLandValue);
    }
    return this.roundTrip(response);
  }

  getEstimate(request: AnyEstimateRequest): Observable<EstimateResponse> {
    // Comparison (NBH-02) is backend-only; not supported in mock.
    if (request.projectType === 'comparison') {
      throw new Error('Comparison not supported in mock');
    }
    if (request.projectType === 'renovation') {
      const response = mockRenoEstimate(request.addressKey, request);
      this.estimateInputs.set(response.estimateId, response.inputs);
      // Track reno inputs for report generation (RENO-04)
      if (response.renoInputs) {
        this.renoEstimateInputs.set(response.estimateId, response.renoInputs);
      }
      return this.roundTrip(response);
    }
    const inputs = this.toInputs(request);
    // Mirror the real backend: land is the property's City assessed value.
    // (Synchronous fixture lookup; see getPreviewEstimate.)
    const addressKey = this.requestAddressKey(request);
    const assessedLandValue =
      mockPropertyFor(addressKey)?.assessedValue ??
      this.propertyAssessedValues.get(addressKey);
    const response = mockEstimate(
      addressKey,
      inputs,
      this.referenceSqft(),
      assessedLandValue,
    );
    this.estimateInputs.set(response.estimateId, inputs);
    if (assessedLandValue !== undefined) {
      this.estimateLandValues.set(response.estimateId, assessedLandValue);
    }
    return this.roundTrip(response);
  }

  /**
   * Neighbourhood comparison (NBH-02 / NBH-03): honest deterministic mock
   * backed by the real City aggregates for stats and the NBH-02 placeholder
   * land math. Replaces the old "not supported" throw — comparison is now
   * exercisable end to end in mock mode.
   */
  getComparisonEstimate(
    request: ComparisonEstimateRequest,
  ): Observable<ComparisonEstimateResponse> {
    try {
      return this.roundTrip(mockComparisonEstimate(request));
    } catch (error) {
      return this.roundTripError(error as ApiError);
    }
  }

  /** Community stats (NBH-01 / NBH-03): real City aggregates, mock latency. */
  getCommunityStats(slug: string): Observable<CommunityStats> {
    try {
      return this.roundTrip(mockCommunityStats(slug));
    } catch (error) {
      return this.roundTripError(error as ApiError);
    }
  }

  submitLead(request: LeadRequest): Observable<LeadResponse> {
    const leadId = `lead-mock-${crypto.randomUUID()}`;
    const token = `mock-${crypto.randomUUID()}`;
    this.issuedTokens.set(token, { estimateId: request.estimateId, leadId });
    return this.roundTrip(mockLeadResponse(leadId));
  }

  /**
   * DEV ONLY unlock (implements the optional {@link ApiService.devTokenForLead}
   * hook): the token the mock "emailed" for a lead, so the analyzing screen
   * can complete the same-session unlock without an email round-trip. The
   * production implementation must never implement this — the magic-link
   * email is the only unlock path there.
   */
  devTokenForLead(leadId: string): string | undefined {
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

  /** Reference size the canned figures are calibrated to (config default). */
  private referenceSqft(): number {
    return this.config.get('wizard').sqftDefault;
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
    const disclaimer = this.config.get('copy').narrativeDisclaimer;
    const version = this.reportVersions.get(ids.estimateId) ?? 1;
    // RENO-04: use reno report if this was a reno estimate
    const renoInputs = this.renoEstimateInputs.get(ids.estimateId);
    if (renoInputs) {
      return this.roundTrip({
        ...mockRenoReport(ids.estimateId, ids.leadId, renoInputs, disclaimer),
        version,
      });
    }
    const inputs = this.estimateInputs.get(ids.estimateId) ?? this.defaultInputs();
    const assessedLandValue = this.estimateLandValues.get(ids.estimateId);
    return this.roundTrip({
      ...mockReport(
        ids.estimateId,
        ids.leadId,
        inputs,
        disclaimer,
        this.referenceSqft(),
        assessedLandValue,
      ),
      version,
    });
  }

  /**
   * AI narrative (consumer/06, dev harness): the mock snapshot already
   * carries the deterministic narrative, so this just re-wraps it in the
   * NarrativeResponse shape. In mock mode the state never calls this —
   * snapshots always ship a narrative — it exists for interface parity.
   */
  getNarrative(estimateId: string, reportToken: string): Observable<NarrativeResponse> {
    return this.getReport(reportToken).pipe(
      map((snapshot) => ({
        estimateId,
        narrative: snapshot.narrative,
        narrativeGeneratedAt: snapshot.preparedAt,
        cached: true,
      })),
    );
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
    // Reno reports stay reno: a stepper/tier revision on a reno token must
    // produce a reno snapshot (with renoInputs), never a new-build one.
    const reno = this.renoEstimateInputs.get(ids.estimateId);
    const version = (this.reportVersions.get(ids.estimateId) ?? 1) + 1;
    this.reportVersions.set(ids.estimateId, version);
    if (reno) {
      const nextReno: RenoEstimateInputs = {
        ...reno,
        tier: request.tier ?? reno.tier,
        renoSqft: request.sqft ?? reno.renoSqft,
      };
      this.renoEstimateInputs.set(ids.estimateId, nextReno);
      const revised = mockRenoReport(
        ids.estimateId,
        ids.leadId,
        nextReno,
        this.config.get('copy').narrativeDisclaimer,
      );
      return this.roundTrip({ ...revised, version });
    }
    const current = this.estimateInputs.get(ids.estimateId) ?? this.defaultInputs();
    const next: EstimateInputs = {
      ...current,
      tier: request.tier ?? current.tier,
      sqft: request.sqft ?? current.sqft,
    };
    // Absolute scaling from the base figures (see scaledMockFigures): re-running
    // the same inputs always reproduces the same figures, so tier toggles round-trip.
    // The land value stays fixed to the property's assessment across revisions.
    const assessedLandValue = this.estimateLandValues.get(ids.estimateId);
    const revised = mockReport(
      ids.estimateId,
      ids.leadId,
      next,
      this.config.get('copy').narrativeDisclaimer,
      this.referenceSqft(),
      assessedLandValue,
    );
    this.estimateInputs.set(ids.estimateId, next);
    return this.roundTrip({ ...revised, version });
  }

  requestCallback(request: CallbackRequest): Observable<CallbackResponse> {
    return this.roundTrip(mockCallbackOk(request.window));
  }

  shareWithPartner(request: PartnerShareRequest): Observable<PartnerShareResponse> {
    return this.roundTrip(mockShareOk(request.partnerEmail));
  }

  /**
   * Dev harness for the unsubscribe center (email/03): any non-empty token
   * resolves as valid — the real backend HMAC-verifies the token, which the
   * mock cannot mint. POST is idempotent: repeat calls report
   * `alreadyUnsubscribed` without changing state.
   */
  getUnsubscribeState(token: string): Observable<UnsubscribeStateResponse> {
    const response: UnsubscribeStateResponse =
      token.trim().length > 0
        ? {
            valid: true,
            leadId: 'mock-lead',
            alreadyUnsubscribed: this.unsubscribedTokens.has(token),
          }
        : { valid: false, reason: 'invalid' };
    return this.roundTrip(response);
  }

  confirmUnsubscribe(token: string): Observable<UnsubscribeResultResponse> {
    const alreadyUnsubscribed = this.unsubscribedTokens.has(token);
    this.unsubscribedTokens.add(token);
    return this.roundTrip({ unsubscribed: true, alreadyUnsubscribed });
  }

  trackEvent(event: AnalyticsEvent): Observable<void> {
    void event;
    return of(undefined);
  }
}
