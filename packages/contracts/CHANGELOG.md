# @feasly/contracts — changelog

## Contract-change policy

These types are the frozen seam between the Angular UI, the mock harness, and the
real backend. Changing them has a cost, so:

- **Additive, optional fields** (new `foo?: T`): minor version bump, entry below.
- **Any breaking change** (rename, removal, optionality flip, type narrowing):
  major version bump + a migration note below. UI and API must agree on the same
  **major** before either ships. (Pre-1.0, breaking changes bump the minor: 0.1 → 0.2.)
- **Never** widen a type to `any` to "unblock" something — the no-`any` lint exists
  precisely to stop that.

## Unreleased — 2026-11-17 (additive) — school designations

Issue #775 (Community Match epic):

- **Added** `school-designations.ts`: `SchoolBoardId` (+ `SCHOOL_BOARD_IDS`),
  `DesignationGradeBand` (+ `DESIGNATION_GRADE_BANDS`), `TYPICALLY_DESIGNATED`,
  `SchoolBoardLookup`, `SchoolDesignation`, `SchoolDesignationsBase`,
  `CommunitySchoolDesignationsResponse`
  (GET /api/v1/communities/{slug}/school-designations) and
  `AddressSchoolDesignationsResponse` (GET /api/v1/school-designations).
  New types only — nothing existing changed.

## Unreleased — 2026-11-16 (additive) — schools directory

Issue #774 (Community Match epic):

- **Added** `schools.ts`: `School`, `SchoolType` (+ `SCHOOL_TYPES`),
  `SchoolProgram`, `SchoolSourceId`, `SchoolAttributedField`,
  `SchoolSourceAttribution`, `SchoolsListResponse` (GET /api/v1/schools) and
  `SchoolResponse` (GET /api/v1/schools/{id}). New types only — nothing
  existing changed.

## Unreleased — 2026-11-16 (additive) — builder settings (#870)

- **Added** builder Settings contracts: `BuilderProfile`,
  `BuilderSupportContact`, `BuilderProfileResponse`,
  `BuilderProfileUpdateBody`, `BuilderEmbedOriginStatus`,
  `BuilderOriginRequestStatus`, `BuilderOriginRequest`,
  `BuilderEmbedResponse`, `BuilderOriginRequestBody`,
  `BuilderOriginRequestResponse`.
- **Added** optional `AnalyticsEvent.embed_origin` (host page origin on
  `embed_loaded`) for the embed install check.

## Unreleased — 2026-11-16 — job queue, link-only shares (#838)

- **Added** link-only report share contracts: `ShareLinkCreateRequest`,
  `ShareLinkCreateResponse`, `ShareLinkStatus`, `ShareLinkSummary`,
  `ShareLinkListRequest`, `ShareLinkListResponse`, `ShareLinkRevokeRequest`,
  `ShareLinkRevokeResponse`.
- **Added** `QueueJobStatus`, `AdminJobSummary`, `AdminJobsResponse` (admin
  view of failed queue jobs).
- **Changed** `PartnerShareVerifySuccess.partnerEmail` to optional — a
  link-only share has no recipient. Migration: no consumer reads the field
  today (the web report page never did); treat it as `string | undefined`.

## Unreleased — 2026-11-16 (additive) — funnel tracking + campaign source

Issue #814 (API half of #702):

- **Added** `AnalyticsEventName` values `landing_view`, `address_search`,
  `address_selected`, `address_no_results`, `out_of_coverage`,
  `property_unsupported`, `preview_view` (replaces the preview `step_view`),
  `estimate_error`, `magic_link_open`, `assessment_view`,
  `assessment_to_estimate`.
- **Added** `AnalyticsSource` (closed: `utm_source`, `utm_medium`,
  `utm_campaign`, `utm_term`, `utm_content`, `click_id_type`), `ClickIdType`
  and `ANALYTICS_SOURCE_FIELD_MAX_LENGTH` (100).
- **Added** optional `AnalyticsEvent.source`, `LeadRequest.source`, and
  `AdminLeadDetail.attribution` (`AnalyticsSource | null`).

## Unreleased — 2026-11-16 (additive) — invisible bot protection

Issue #788 (follow-up to #750):

- **Added** optional `LeadRequest.elapsedMs`. This is how long, in ms, the gate
  form was on screen before submit. The API quarantines submissions faster than
  `LEAD_MIN_SUBMIT_MS`, the same way it handles the honeypot.
- **Added** `ChallengeRequiredError` (`error.ts`). This is the 403 sent when an
  IP that tripped a shared rate limit must pass Cloudflare Turnstile. It carries
  `challenge.provider` and the public `challenge.siteKey`. The client sends the
  token it gets back in the `X-Turnstile-Token` header (`BOT_CHALLENGE_HEADER`).

## Unreleased — 2026-11-16 (additive) — builder partners

Builder partner disclosure (issue #888, API half of #847):

- **Added** `partners.ts`: public `BuilderPartner` / `BuilderPartnerListResponse`
  for `GET /api/v1/partners` (active partners, display order, company name
  only — no contact details), and admin `AdminBuilderPartner` /
  `AdminBuilderPartnerListResponse` / `BuilderPartnerCreateBody` /
  `BuilderPartnerUpdateBody` for `/api/v1/admin/partners`.

## Unreleased — 2026-11-16 (additive) — community lots

Community lot inventory, phase 1 (issue #691):

- **Added** `CommunityLot`, `CommunityLotsResponse`, `CommunityLotKind`,
  `CommunityLotDistrictSource`, `CommunityLotSort` (served by
  `GET /api/v1/communities/{slug}/lots`). The only money value is the
  City-assessed value, passed through verbatim.

## Unreleased — 2026-11-16 (additive)

Admin refunds, void, contract correction, manual-payment reversal (issue #715):

- **Added** optional `CommissionInvoice.refundedCents`, `refundState`
  (`InvoiceRefundState`: `none` | `partially_refunded` | `refunded` — derived,
  not a status) and `refunds` (`InvoiceRefund[]`, single-invoice reads only).
- **Added** `InvoiceRefund`, `InvoiceRefundReason`, `InvoiceRefundMethod`,
  `InvoiceRefundStatus`; request/response pairs `RefundInvoiceRequest` /
  `RefundInvoiceResponse`, `VoidInvoiceRequest` / `VoidInvoiceResponse`
  (+ `VoidInvoiceReason`), `CorrectContractRequest` /
  `CorrectContractResponse`, `ReverseManualPaymentRequest` /
  `ReverseManualPaymentResponse` for the four new admin billing endpoints.

Project-type steer by home age (issue #755):

- **Added** optional `PropertyRecord.steer` (`PropertySteer`:
  `redevelopmentCandidate` (boolean | null), `reason` (`PropertySteerReason`),
  `recommendedProjectType`, `homeAgeYears`, `thresholdYears`). Computed by the
  API from the year built and `PROPERTY_REDEVELOPMENT_MIN_AGE_YEARS`; absent
  means "no steering".
- **Added** `AnalyticsEventName` values `steer_new_build_offered`,
  `steer_renovation_offered`, `steer_none_offered`, `steer_override_new_build`.

## Unreleased — 2026-11-15 (additive)

Platform agreement + builder onboarding (issue #722):

- **Added** `agreement.ts`: `AgreementStatus` (`version`, `current`,
  `acceptedAt`, `acceptedBy`, `canAccept`, `document`), `AgreementDocument`
  (+ `AgreementDocumentSection`, `AgreementDocumentStatus`),
  `AgreementAcceptedBy`, `AcceptAgreementRequest` (`version`),
  `AcceptAgreementResponse`, `BuilderOnboardingStatus` (checklist flags +
  `isAdmin` + `agreement`), `AdminBuilderAgreementSummary`, and the
  `AgreementErrorCodes` constant (`AGREEMENT_REQUIRED`,
  `AGREEMENT_ADMIN_REQUIRED`, `AGREEMENT_VERSION_MISMATCH`).
- **Added** `AdminBuilderDetail` (`Builder` + `agreement`) — the response of
  `GET /api/v1/admin/builders/{id}`. Additive: every `Builder` field is kept.
Audit log viewer, finance exports and builder activity (issue #728):

- **Added** `audit.ts`: `AuditLogEntry` / `AuditLogListQuery` /
  `AuditLogListResponse` (merged admin + billing audit trail, keyset
  cursor) for `GET /api/v1/admin/audit`; `FinanceSummary` (+ per-builder
  rows, integer cents) for `GET /api/v1/admin/billing/summary`;
  `INVOICE_EXPORT_COLUMNS` (invoice CSV header); `BuilderActivityEntry` /
  `BuilderActivityResponse` for `GET /api/v1/builder/activity`.

Zoning rules catalogue (issue #687):

- **Added** `zoning.ts`: `BuildingForm` (+ `BUILDING_FORMS`),
  `ZoningDistrictCategory`, `ZoningCoverage`, `FormPermission`; source
  shapes `ZoningRulesVersion` / `ZoningDistrictSource` / `ZoningFormSource` /
  `ZoningRuleSource` (each value carries a bylaw `section` and `verified`);
  public verified-only shapes `ZoningDistrict` / `ZoningForm` / `ZoningRule` /
  `ZoningKeyRules` and `ZoningDistrictsResponse` for
  `GET /api/v1/zoning/districts`.

Current land-use district (issue #686):

- **Added** optional `PropertyRecord.landUse` (`PropertyLandUse`: `district`,
  `description`, `source`, `asOf`, optional `dcBylaw`) and `LandUseSource`
  (`land-use-districts` | `assessment-roll`). `zoning` keeps its type; it now
  carries the current district from the City's Land Use Districts map when
  known, and the assessment roll's designation otherwise.

Waitlists for renovation and other cities (issue #520):

- **Added** `waitlist.ts`: `WaitlistTopic` (`renovation` | `toronto` |
  `vancouver`), `WaitlistRequest` (`email`, `topic`) and `WaitlistResponse`
  for `POST /api/v1/waitlist`. `WaitlistRequest.consent` is the required
  CASL consent checkbox (`true`); the API rejects a signup without it.
- **Added** optional `PrivacyExportResponse.waitlistSignups`
  (`PrivacyWaitlistSignupExport`: `topic`, `createdAt`, `consentTs`,
  `consentVersion`): the privacy export covers waitlist signups.


Builder Leads home "Needs you" feed (issue #526):

- **Added** `BuilderLeadsNeedsYouResponse` (`uncontacted`, `stale`,
  `wonWithoutContract`, `staleAfterDays`, `counts`) and
  `BuilderLeadNeedsYouItem` for `GET /api/v1/builder/leads/needs-you`.
- **Added** `BuilderLeadStatusCounts`; `BuilderLeadListResponse.summary` now
  uses it (same shape, no change on the wire).

## 0.3.0 — 2026-09-24 (additive)

PIPEDA self-service privacy endpoints (legal/02):

- **Added** `privacy.ts`: `PrivacyExportResponse` (leads, estimate snapshots,
  magic-link lifecycle metadata — token hashes never included — erasure-request
  history, draft retention notice; `reportShares` / `callbackRequests` ship as
  empty arrays until their server-side stores land), `ErasureRequestResponse`
  (consequences statement), `ErasureConfirmResponse`.

## 0.2.0 — 2026-09-24 (breaking, pre-1.0)

Post-merge audit fixes (FE0-001 corrective):

- **Blur guarantee is now structural.** `EstimateResponse.figures` no longer takes
  the `Figure` union: post-gate figures are all `CostRange`, and the new
  `PreviewEstimateResponse` (the name BE2-002/BE3-002 already specified) carries
  only `BlurredFigure`s with `rows: readonly []`. A route typed to return the
  preview cannot leak a real dollar amount — mixing real and blurred figures is a
  compile error, not a code-review catch. Removed the now-unneeded `EstimateFigures`
  mixed type.
- **Contracts are shapes-only.** Removed the `isBlurred`/`isCostRange` runtime
  guards from `common.ts`. Narrowing helpers belong in the consuming layer (UI
  shared utils, API lib), never in the frozen seam. (`registry.ts` keeps its
  `CONTRACT_NAMES`/`CONTRACTS_VERSION` constants — frozen data for the FE0-003
  mock-harness conformance test, not logic.)
- **Copy out of contracts.** Removed `NARRATIVE_DISCLAIMER` from `report.ts`.
  Verbatim UI copy now lives in typed app config (owner: FE0-002 ConfigService,
  key `content.narrativeDisclaimer` in `app-config.json`). Exact text preserved:
  'Dollar figures are calculated deterministically from our cost model — not generated by AI.'
- **Embed directionality fixed.** `feasly:resize` flows iframe→parent, so
  `EmbedParentMessage` no longer includes it. New `EmbedIframeMessage` type for
  iframe→parent messages; `EmbedParentMessage` is now parent→iframe only.
- **Added** `GetReportResponse` alias (`= ReportSnapshot`), symmetric with
  `TierRevisionResponse`.

Migration: replace `EstimateFigures` usage with the pre/post-gate response types;
replace `isBlurred(f)` / `isCostRange(f)` with structural checks in your own layer
(the split estimate types make the guards unnecessary at the seam).

## 0.1.0 — 2026-09-23

Initial frozen UI contracts (FE0-001): `common`, `property`, `estimate`, `lead`,
`magic-link`, `report`, `callback`, `share`, `events`, `embed`, `community`, `error`,
plus the `registry` (contract list + version) consumed by the FE0-003 mock-harness
conformance test.
