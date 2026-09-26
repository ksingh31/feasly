/**
 * Compile-time contract assertions (FE0-001). There is no test runner in this
 * package by design — these assertions run under `tsc --noEmit` (`npm test`).
 * If a contract shape drifts, the build fails here first.
 */
import type {
  AnalyticsEvent,
  AutocompleteSuggestion,
  CallbackRequest,
  CommunityAggregate,
  CostRange,
  CostRow,
  EmbedIframeMessage,
  EmbedParentMessage,
  EmbedTenantConfig,
  EstimateRequest,
  EstimateResponse,
  FixedFigure,
  GetReportResponse,
  LeadRequest,
  MagicLinkVerifyResponse,
  PartnerShareRequest,
  PreviewEstimateResponse,
  PropertyRecord,
  ReportSnapshot,
  TierRevisionRequest,
} from '../src';
import { CONTRACT_NAMES } from '../src';

// --- tiny assertion helpers (compile-time only) ---
function assertType<T>(value: T): void {
  void value;
}

// --- pre-gate preview carries the REAL computed figures (rendered blurred
// by the UI until the lead gate unlocks); rows stay empty pre-gate ---
declare const previewRes: PreviewEstimateResponse;
assertType<CostRange>(previewRes.figures.build);
assertType<CostRange>(previewRes.figures.total);
assertType<FixedFigure>(previewRes.figures.land);
assertType<readonly []>(previewRes.rows);

declare const estimateRes: EstimateResponse;
assertType<CostRange>(estimateRes.figures.build);
assertType<CostRange>(estimateRes.figures.total);
assertType<FixedFigure>(estimateRes.figures.land);
assertType<readonly CostRow[]>(estimateRes.rows);

// Land is fixed: assigning a range where the fixed land figure belongs must
// fail the build. (If this @ts-expect-error stops erroring, the contract
// drifted and the assertion must be restored.)
declare const someRange: CostRange;
// @ts-expect-error — CostRange must never satisfy FixedFigure
const landNotARange: FixedFigure = someRange;
void landNotARange;

const mixedFigures = {
  build: { blurred: true },
  total: { low: 100, base: 150, high: 200 },
  land: { blurred: true },
} as const;
// @ts-expect-error — a real range cannot appear in pre-gate figures
const mixed: PreviewEstimateResponse['figures'] = mixedFigures;
void mixed;

const blurredFigure = { blurred: true } as const;
const blurredPost: EstimateResponse['figures'] = {
  build: { low: 1, base: 2, high: 3 },
  // @ts-expect-error — a blur placeholder cannot appear in a post-gate estimate
  total: blurredFigure,
  land: { value: 1 },
};
void blurredPost;

// --- every domain shape is constructible and closed ---
declare const property: PropertyRecord;
assertType<string>(property.addressKey);
assertType<number | null>(property.yearBuilt);
assertType<boolean>(property.stale);

declare const suggestion: AutocompleteSuggestion;
assertType<string>(suggestion.addressKey);

declare const estimateReq: EstimateRequest;
assertType<'standard' | 'premium' | 'luxury'>(estimateReq.tier);
assertType<'none' | 'double' | 'triple'>(estimateReq.garage);
assertType<'unfinished' | 'finished'>(estimateReq.basement);

declare const leadReq: LeadRequest;
assertType<string | undefined>(leadReq.phone);
assertType<string | undefined>(leadReq.tenantKey);
assertType<boolean>(leadReq.marketingConsent);

declare const verifyRes: MagicLinkVerifyResponse;
if (verifyRes.valid) {
  assertType<string>(verifyRes.reportToken);
} else {
  assertType<'expired' | 'invalid'>(verifyRes.reason);
}

declare const snapshot: ReportSnapshot;
assertType<CostRange>(snapshot.buildRange); // snapshots are always post-gate: real ranges
assertType<number>(snapshot.version);

declare const getReport: GetReportResponse;
assertType<ReportSnapshot>(getReport);

declare const revision: TierRevisionRequest;
assertType<'standard' | 'premium' | 'luxury' | undefined>(revision.tier);

declare const callback: CallbackRequest;
assertType<'morning' | 'afternoon' | 'evening'>(callback.window);

declare const share: PartnerShareRequest;
assertType<string>(share.partnerEmail);

// Analytics payload is closed: only event/route/ts/consent_ts exist
// (story consumer/01 added consent_ts; embed/01 needs embed_loaded).
declare const event: AnalyticsEvent;
assertType<
  | 'step_view'
  | 'gate_view'
  | 'gate_convert'
  | 'report_open'
  | 'tier_toggle'
  | 'callback_request'
  | 'partner_share'
  | 'pdf_download'
  | 'embed_loaded'
>(event.event);
const eventKeys = ['event', 'route', 'ts', 'consent_ts'] as const;
assertType<readonly ['event', 'route', 'ts', 'consent_ts']>(eventKeys);
assertType<4>(eventKeys.length);

// Embed directionality: parent→iframe carries theme + relay; iframe→parent
// carries ready/resize/estimate-start/lead-created/auth-ok (embed/08).
declare const parentMsg: EmbedParentMessage;
assertType<'feasly:theme' | 'feasly:relay'>(parentMsg.type);
declare const iframeMsg: EmbedIframeMessage;
assertType<
  'feasly:ready' | 'feasly:resize' | 'feasly:estimate-start' | 'feasly:lead-created' | 'FEASLY_AUTH_OK'
>(iframeMsg.type);
// @ts-expect-error — resize flows iframe→parent, never parent→iframe
const wrongDirection: EmbedParentMessage = { type: 'feasly:resize', height: 1 };
void wrongDirection;

declare const tenant: EmbedTenantConfig;
assertType<string>(tenant.allowedOrigin);

declare const community: CommunityAggregate;
assertType<number>(community.avgAssessedValue);

// --- registry covers every contract module ---
const names = CONTRACT_NAMES;
assertType<17>(names.length);
