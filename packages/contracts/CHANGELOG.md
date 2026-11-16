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
