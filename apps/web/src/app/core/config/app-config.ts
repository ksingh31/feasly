/**
 * Typed application configuration.
 *
 * Everything tunable lives here — never as literals in components or services.
 * The JSON file at `/assets/config/app-config.json` is deep-merged over
 * {@link DEFAULT_APP_CONFIG} at startup (see ConfigService), so any key may be
 * omitted there and the compiled default applies.
 *
 * FE1-001+ will extend the `copy` section with page-level strings.
 */
import type { BasementOption, CallbackWindow, FinishTier, GarageOption, TimelineOption } from '@feasly/contracts';

/**
 * One trust-strip stat block on the landing page: a big display value with a
 * small supporting label underneath.
 * - `valueShort`: optional compact value shown on narrow screens
 *   (e.g. "Sep 2026" instead of "September 2026"); falls back to `value`.
 * - `badge`: renders a brass check badge above the value instead of the
 *   large display number (for non-numeric stats like "Same fixed formula").
 * - `key` + `refreshedValue`/`refreshedValueShort`: runtime-rewritten items.
 *   The item with `key: 'city-data-freshness'` gets its `value` replaced at
 *   runtime with the live dataset-refresh month from
 *   GET /api/v1/city-data/freshness ("{monthYear}" → "September 2026").
 *   While the month is unknown the item keeps its
 *   configured `value` fallback ("Live City data") — never a hardcoded
 *   month that goes stale.
 */
export interface TrustStat {
  value: string;
  valueShort?: string;
  label: string;
  badge?: boolean;
  /** Stable key for items the page rewrites at runtime. */
  key?: string;
  /**
   * Display template used when the live refresh month is known, e.g.
   * "{monthYear}". Only meaningful with `key`.
   */
  refreshedValue?: string;
  /** Compact template for narrow screens, e.g. "{monthYearShort}". */
  refreshedValueShort?: string;
}

/** Builder Entra tenant wiring (infrastructure config — needed at root). */
export interface BuilderEntraConfig {
    /** Builder Entra tenant subdomain ({sub}.ciamlogin.com). */
    tenantSubdomain: string;
    /** Builder Entra tenant (directory) ID. */
    tenantId: string;
    /** Builder Entra app (client) ID. */
    clientId: string;
    /** Builder Entra user flow / policy name. */
    userFlow: string;
    /**
     * OAuth2 authorize endpoint template; {tenantSubdomain} and
     * {tenantId} are interpolated at runtime.
     */
    authorizeUrlTemplate: string;
}

/**
 * User-facing builder-portal copy. Lazy-loaded with the builder portal
 * (features/builder/builder-copy.defaults.ts, provided as BUILDER_COPY)
 * so the initial bundle doesn't carry it.
 */
export interface BuilderCopy {
  loginHeading: string;
  loginExpired: string;
  emailInvalid: string;
  retryLabel: string;
  shellBrand: string;
  shellNavDashboard: string;
  signOutLabel: string;
  dashboardHeading: string;
  loadingLeads: string;
  loadError: string;
  emptyLeads: string;
  filterLabel: string;
  filterAllLabel: string;
  emptyFilterLeads: string;
  summaryHeading: string;
  summaryTotal: string;
  statusLabels: {
      new: string;
      contacted: string;
      quoted: string;
      won: string;
      lost: string;
  };
  updateForbidden: string;
  updateFailed: string;
  leadEmailLabel: string;
  leadAddressLabel: string;
  leadPhoneLabel: string;
  leadTimelineLabel: string;
  leadScoreLabel: string;
  leadProjectLabel: string;
  leadCreatedLabel: string;
  leadStatusUpdatedLabel: string;
  actionsLabel: string;
  shellNavBilling: string;
  shellNavInvoices: string;
  shellNavReportContract: string;
  reportContractSeoDescription: string;
  reportContractHeading: string;
  reportContractExplainer: string;
  reportContractLeadLabel: string;
  reportContractLeadRequired: string;
  reportContractLeadsLoading: string;
  reportContractLeadsError: string;
  reportContractLeadsEmpty: string;
  recordContractNoReportableLeads: string;
  recordContractAlreadyRecordedTitle: string;
  recordContractAlreadyRecordedBody: string;
  reportContractValueLabel: string;
  reportContractValueHint: string;
  reportContractValueRequired: string;
  reportContractValueInvalid: string;
  reportContractDateLabel: string;
  reportContractDateRequired: string;
  reportContractDateFuture: string;
  reportContractSubmit: string;
  reportContractSubmitting: string;
  reportContractSuccessTitle: string;
  reportContractSuccessBody: string;
  reportContractAlreadyReported: string;
  reportContractDisputed: string;
  reportContractFlatCovered: string;
  reportContractNotEnabled: string;
  reportContractAwaitingDetails: string;
  recordContractViewInvoice: string;
  recordContractBackToLeads: string;
  recordContractReviewDeadline: string;
  recordContractAutoCharge: string;
  recordContractZeroCommission: string;
  billingHeading: string;
  billingLoading: string;
  billingLoadError: string;
  billingNoCard: string;
  billingCardOnFile: string;
  billingAddCard: string;
  billingUpdateCard: string;
  billingFormHeading: string;
  billingSaveCard: string;
  billingSavingCard: string;
  billingCardSaved: string;
  billingSaveFailed: string;
  billingUnavailable: string;
  billingCancel: string;
  billingExplainer: string;
  billingDefaultMethodTitle: string;
  billingDefaultMethodHelper: string;
  billingDefaultMethodLabel: string;
  billingDefaultMethodSaved: string;
  billingDefaultMethodSaveFailed: string;
  billingDefaultMethodApply: string;
  billingDefaultMethodApplying: string;
  billingDefaultMethodReset: string;
  billingMethodCard: string;
  billingMethodCardWithLast4: string;
  billingMethodCardNoCard: string;
  billingMethodCheque: string;
  billingMethodETransfer: string;
  billingMethodBankDraft: string;
  invoicesHeading: string;
  invoicesExplainer: string;
  invoicesLoading: string;
  invoicesLoadError: string;
  invoicesEmpty: string;
  invoicesColDate: string;
  invoicesColInvoiceNumber: string;
  invoicesColContract: string;
  invoicesColCommission: string;
  invoicesColStatus: string;
  invoicesColDue: string;
  invoicesColLead: string;
  invoiceStatusDraft: string;
  invoiceStatusInReview: string;
  invoiceStatusFinalized: string;
  invoiceStatusPaid: string;
  invoiceStatusFailed: string;
  invoiceStatusDisputed: string;
  invoiceStatusVoid: string;
  invoicesAutoChargeIn: string;
  invoicesAutoChargeTomorrow: string;
  invoicesAutoChargeToday: string;
  invoicesPaymentFailed: string;
  invoicesPaymentReceived: string;
  invoicesUpdateCardCta: string;
  invoicesNumberRow: string;
  invoicesFilterNumberLabel: string;
  invoicesFilterNumberPlaceholder: string;
  invoicesFilterNumberClear: string;
  invoicesFilterEmpty: string;
  invoicesPaymentMethodRow: string;
  invoicesPaymentMethodLocked: string;
  invoicesPaymentMethodSaveFailed: string;
  invoicesPaymentMethodManualNote: string;
  invoicesPaymentMethodApply: string;
  invoicesPaymentMethodApplying: string;
  invoicesPaymentMethodSaved: string;
  invoicesPaymentMethodReset: string;
  invoicesReviewNoteManual: string;
  invoicesBackToList: string;
  invoicesReceiptHeading: string;
  invoicesLineItemsHeading: string;
  invoicesTimelineHeading: string;
  invoicesContractRow: string;
  invoicesCommissionRow: string;
  invoicesReceiptAmount: string;
  invoicesReceiptDate: string;
  invoicesReceiptCard: string;
  invoicesReviewNote: string;
  invoicesPrevPage: string;
  invoicesNextPage: string;
  invoicesPageOf: string;
  invoicesPage: string;
  invoicesPageSize: number;
  invoicesSeoDescription: string;
  invoicesTimelineCreated: string;
  invoicesTimelineReviewEnds: string;
  invoicesTimelineFinalized: string;
  invoicesTimelinePaid: string;
  invoicesTimelineFailed: string;
  dueBannersHeading: string;
  dueBannersHeadingSingular: string;
  dueBannersCollapseAll: string;
  dueBannersBarFailedLead: string;
  dueBannersBarFailedTail: string;
  dueBannersBarDueTodayLead: string;
  dueBannersBarDueTodayTail: string;
  dueBannersBarOverdueLead: string;
  dueBannersBarOverdueTail: string;
  dueBannersMeta: string;
  dueBannersMethodLine: string;
  dueBannersCardLabel: string;
  dueBannersNoCardOnFile: string;
  dueBannersUpdateCardCta: string;
  dueBannersViewInvoiceCta: string;
  dueBannersViewInvoiceLink: string;
  dueBannersDismissLabel: string;
  dueBannersDismissAllLabel: string;
  entraSignInLabel: string;
  entraSignInIntro: string;
  entraRedirecting: string;
  entraNotConfigured: string;
  entraCallbackVerifying: string;
  entraCallbackCancelled: string;
  entraCallbackStateMismatch: string;
  entraCallbackTransient: string;
  entraCallbackBackToLogin: string;
  orgPickerHeading: string;
  orgPickerIntro: string;
  orgPickerLoading: string;
  orgPickerError: string;
  orgPickerRetry: string;
  orgSwitcherLabel: string;
  orgRoleAdmin: string;
  orgRoleMember: string;
  teamNavLabel: string;
  teamHeading: string;
  teamIntro: string;
  teamLoading: string;
  teamLoadError: string;
  teamRetry: string;
  teamEmpty: string;
  teamColName: string;
  teamColEmail: string;
  teamColRole: string;
  teamApplyRole: string;
  teamColStatus: string;
  teamColActions: string;
  teamStatusActive: string;
  teamStatusInvited: string;
  teamStatusDeactivated: string;
  teamInviteHeading: string;
  teamInviteNameLabel: string;
  teamInviteNameInvalid: string;
  teamInviteEmailLabel: string;
  teamInviteRoleLabel: string;
  teamInviteSubmit: string;
  teamInviteSending: string;
  teamInviteSent: string;
  teamInviteError: string;
  teamInviteDuplicateMember: string;
  teamInviteDuplicatePending: string;
  teamDeactivateLabel: string;
  teamReactivateLabel: string;
  teamRemoveLabel: string;
  teamRemoving: string;
  teamDeactivating: string;
  /** Builder-side view-as (2026-09-30, Karan): row action + error copy. */
  teamViewAsLabel: string;
  teamViewAsStarting: string;
  teamViewAsError: string;
  teamViewAsForbidden: string;
  teamDeactivateConfirm: string;
  teamRemoveConfirm: string;
  /** auth/07: explainer shown under the disabled role select / Deactivate
      for the sole remaining active admin (exact story copy). */
  teamLastAdminRoleNote: string;
  teamLastAdminDeactivateNote: string;
  teamConfirmYes: string;
  teamConfirmNo: string;
  teamActionError: string;
  shellHomeLabel: string;
  shellMenuOpenLabel: string;
  shellMenuCloseLabel: string;
  leadsSubtitle: string;
  leadsEmptyHeading: string;
  leadsEmptyGuidance: string;
  leadsFilterEmptyHeading: string;
  leadsFilterEmptyGuidance: string;
  leadsErrorHeading: string;
  leadsClearFilter: string;
  leadsStatusControlLabel: string;
  leadsStatusSaving: string;
  leadsStatusApply: string;
  leadsStatusLocked: string;
  /** Notes section header on each lead card. */
  commentsSectionTitle: string;
  /** Empty-state CTA that expands the thread. */
  commentsAddFirstNote: string;
  /** Empty-state hint above the CTA. */
  commentsEmptyHint: string;
  /** Composer footnote: who can see builder-posted notes. */
  commentsVisibleToOrg: string;
  /** Badge on notes written by the Feasly team (shared admin notes). */
  commentsTeamBadge: string;
  commentsEmpty: string;
  commentsPostFailed: string;
  commentsEditFailed: string;
  commentsMaxLength: number;
  leadsWonHint: string;
  leadsWonReportCta: string;
  leadsRecordedCta: string;
  leadsViewInvoiceCta: string;
  leadsViewInvoiceWithNumber: string;
  teamColAdded: string;
  teamInviteButton: string;
  teamInviteModalSub: string;
  teamCountOne: string;
  teamCountMany: string;
  teamNotAdmin: string;
  billingCardPanelTitle: string;
  billingCardBrandLabel: string;
  billingCardNumberLabel: string;
  billingCardExpiryLabel: string;
  billingCardEmptyTitle: string;
  billingCardEmptyBody: string;
  contractWhatHappensTitle: string;
  contractFormHeading: string;
  contractLeadPlaceholder: string;
  contractEstimatedCommission: string;
  contractCommissionPanelSub: string;
  contractCommissionContractValue: string;
  contractCommissionRate: string;
  contractRetry: string;
}

export interface AppConfig {
  /** Public site facts. */
  site: {
    /** Canonical origin, e.g. https://feasly.com. No trailing slash. */
    url: string;
    /** Brand name shown in the shell. */
    name: string;
    /** Site-root-relative path of the 1200×630 social share image. */
    socialImage: string;
  };
  /** Backend wiring. */
  api: {
    /** Base URL for /api/v1. Empty string = same origin. */
    baseUrl: string;
    /** True while the backend is unimplemented: use the mock harness (FE0-003). */
    useMockApi: boolean;
    /** HTTP timeout for API calls. */
    timeoutMs: number;
    /**
     * Gate-submit timeout. The lead-gate POST waits on the synchronous
     * email send (in-code retries: worst case ~20s), so it gets headroom
     * over the global timeout — without slowing every other API call.
     */
    gateTimeoutMs: number;
    /**
     * CSV-export timeout. Bulk export on a cold Azure Function plus CSV
     * generation for thousands of rows can exceed the standard timeout.
     */
    exportTimeoutMs: number;
    /**
     * Delay before revoking a blob object URL after a programmatic download
     * click. Revoking synchronously aborts the download in Safari/WebKit.
     */
    downloadRevokeDelayMs: number;
  };
  /**
   * Billing wiring (billing/02, BILL-02). Stripe publishable key for the
   * builder-portal card form (Stripe Elements). Empty string = card setup
   * is unavailable in the UI (the backend fails closed too). The secret key
   * never reaches the browser — it stays in the Function App's settings.
   */
  billing: {
    /** Stripe publishable key (`pk_test_…` in dev). Empty = unavailable. */
    stripePublishableKey: string;
  };
  /** Property-data wiring (FE1-002): autocomplete + property records. */
  propertyData: {
    /**
     * Which property backend serves autocomplete + property records:
     * - 'live': City of Calgary open-data Socrata API (free, no key).
     * - 'mock': FE0-003 fixture harness (offline dev / CI).
     * - 'backend': our own /api/v1 property routes (BE-3+, when they exist).
     * Independent from `api.useMockApi`, which still switches the estimate /
     * lead / magic-link contracts.
     */
    source: 'live' | 'mock' | 'backend';
    /** Socrata host for the City dataset. No trailing slash. */
    baseUrl: string;
    /** Socrata dataset id for Current Year Property Assessments (Parcel). */
    datasetId: string;
    /** Rows fetched per autocomplete query before client-side dedupe. */
    searchRowLimit: number;
    /** TTL for cached Socrata responses (courtesy rate limiting). */
    cacheTtlMs: number;
  };
  /** Feature flags. */
  features: {
    /** Show the "view sample report" entry point. */
    sampleReport: boolean;
    /** Show the renovation waitlist capture instead of the estimator. */
    renovationWaitlist: boolean;
  };
  /**
   * Legal review state (legal/01 AC3 — the LEGAL_REVIEW_PENDING mechanism).
   * True while the privacy/terms copy is draft-pending-lawyer: the legal
   * pages render the "draft — pending legal review" banner, and the HRD-05
   * legal gate blocks production deploys while true.
   */
  legal: {
    /** Draft legal copy is still awaiting lawyer review. */
    reviewPending: boolean;
  };
  /** Wizard tunables (FE-2). */
  wizard: {
    sqftDefault: number;
    sqftMin: number;
    sqftMax: number;
    /** Slider step in sq ft. */
    sqftStep: number;
    /** Reno scope step tunables (RENO-03). */
    renoSqftDefault: number;
    renoSqftMin: number;
    renoSqftMax: number;
    /** Reno slider step in sq ft. */
    renoSqftStep: number;
    /** Additions bill at most this many sq ft (RENO-01). */
    renoAdditionCap: number;
  };
  /** UX timings. */
  timings: {
    /** Address-autocomplete debounce. */
    debounceMs: number;
    /** Report sqft-stepper live-revise debounce (D-02: 400 ms trailing). */
    reviseDebounceMs: number;
    /** Cooldown between magic-link resends. */
    resendCooldownSec: number;
    /** Mock API latency window (FE0-003). Real API ignores these. */
    mockLatencyMinMs: number;
    mockLatencyMaxMs: number;
    /** Analyzing pipeline stage timeout (an API stage slower than this fails honestly). */
    analyzingTimeoutMs: number;
  };
  /** Collection limits. */
  limits: {
    /** Max communities rendered on community listing pages. */
    communityPageLimit: number;
    /** Max address suggestions shown in autocomplete. */
    autocompleteSuggestionLimit: number;
    /**
     * Estimate input bounds, mirrored from the cost-data file
     * (packages/cost-engine/cost-data inputBounds). The property record
     * arrives direct from Socrata (propertyData.source 'live'), so the
     * client needs the assessed-value bounds for the early coverage guard.
     * `minLotSizeSqft`/`maxLotSizeSqft` are RESERVED for future bigger-lot
     * calibration (Karan, 2026-09-28) — NOT enforced anywhere; the
     * estimator never blocks on lot size. estimate-input-bounds-drift.spec.ts
     * fails CI if the values diverge from the cost data.
     */
    minLotSizeSqft: number;
    maxLotSizeSqft: number;
    minAssessedLandValue: number;
    maxAssessedLandValue: number;
  };
  /** Analytics consent. */
  analytics: {
    enabled: boolean;
    /** Exact opt-in wording shown to the user. */
    optInWording: string;
  };
  /** User-facing copy, namespaced by area. Extended by FE1-001. */
  admin: {
    /** Default per-minute rate limit prefilled in the issue form. */
    defaultRateLimit: number;
    /**
     * Microsoft Entra External ID (auth/02 pivot, AUTH-02). All three are
     * deploy-time values — the compiled defaults are placeholders that
     * MUST be replaced in app-config.json before the Entra flow can start.
     */
    entra: {
      /**
       * Tenant subdomain: sign-in happens at
       * `https://{tenantSubdomain}.ciamlogin.com/{tenantId}/…`.
       * Placeholder key name: ENTRA_TENANT_SUBDOMAIN.
       */
      tenantSubdomain: string;
      /**
       * Directory (tenant) ID from the Entra External ID tenant.
       * Placeholder key name: ENTRA_TENANT_ID.
       */
      tenantId: string;
      /**
       * Application (client) ID of the Feasly admin app registration.
       * Placeholder key name: ENTRA_CLIENT_ID.
       */
      clientId: string;
      /**
       * Sign-up/sign-in user flow name (e.g. `feasly-signup-signin`).
       * Passed as the `p` query parameter on the authorize request so
       * Entra External ID runs the right flow. Without it the authorize
       * request is rejected.
       * Placeholder key name: ENTRA_USER_FLOW.
       */
      userFlow: string;
      /**
       * Microsoft-hosted authorize endpoint template. `{tenantSubdomain}`
       * and `{tenantId}` are substituted at sign-in time. Lives in config
       * (not code) so sovereign clouds (e.g. `ciamlogin.us`) or future
       * endpoint versions need no code change.
       */
      authorizeUrlTemplate: string;
    };
  };
  copy: {
    /** Short brand tagline used in the shell footer / meta fallbacks. */
    tagline: string;
    /**
     * Verbatim footer on every AI narrative (moved out of @feasly/contracts in
     * the FE0-001 audit — contracts are shapes-only; copy lives in config).
     * Exact wording is copy-linted: do not paraphrase.
     */
    narrativeDisclaimer: string;
    /**
     * Landing page (S0) copy. Every string rendered on `/` lives here so the
     * no-hardcode tripwire stays green and copy is deploy-tunable.
     * `trustItems` must never carry ±, %, or accuracy claims (copy-linted).
     */
    landing: {
      eyebrow: string;
      heroTitle: string;
      heroSub: string;
      /** Short description for SEO JSON-LD (WebSite schema). */
      seoDescription: string;
      /** Trust-strip stat blocks (redesigned 2026-09-28): big value + small label. */
      trustItems: TrustStat[];
      /**
       * Shown instead of `trustItems` while the mock property harness
       * serves the data (`propertyData.source === 'mock'`): sample values
       * must never claim live City data (trust rule).
       */
      trustItemsMock: TrustStat[];
      /** Small caps label above the trust-strip stats ("Why Feasly"). */
      trustEyebrow: string;
      howItWorksTitle: string;
      howItWorksSub: string;
      steps: { n: string; title: string; body: string }[];
      /** Label for the optional sample-report entry (needs `features.sampleReport`). */
      sampleReportLabel: string;
      /**
       * Substantive SEO sections on the landing page (SEO pass 4): keyword-
       * bearing, buyer-grade content for the target intents (cost to build,
       * renovations, builders). Links are plain copy — anchors live in the
       * template.
       */
      seoSections: {
        costFactorsTitle: string;
        costFactorsBody: string;
        renoTitle: string;
        renoBody: string;
        buildersTitle: string;
        buildersBody: string;
        buildersCta: string;
      };
    };
    /** Address-autocomplete strings, shared by landing (S0) and wizard (S1). */
    search: {
      label: string;
      placeholder: string;
      submitLabel: string;
      /** Shown when submitting with fewer than 3 characters typed. */
      emptyHint: string;
      /**
       * Shown when submitting with 3+ characters typed but no suggestion
       * selected: the CTA must never proceed with an unresolved address.
       */
      selectHint: string;
      /** Shown when a 3+ char query returns zero suggestions. */
      noResults: string;
      /**
       * Calgary-only gate (reno/05): exact story-pinned copy. Shown when the
       * property lookup reports OUT_OF_COVERAGE. Do not paraphrase.
       */
      outOfCoverageHeading: string;
      outOfCoverageBody: string;
      /** Shown when the autocomplete request fails. */
      error: string;
      retryLabel: string;
      searchingLabel: string;
    };
    /**
     * White-label embed shell strings (EMB-01). The unavailableBody copy is
     * story-pinned — the exact fallback text, never a blank iframe.
     */
    embed: {
      /** Screen-reader label for the widget region. */
      widgetLabel: string;
      /** Shown while the builder config loads. */
      loadingLabel: string;
      /** Fallback card heading when the tenant config can't be resolved. */
      unavailableHeading: string;
      /** Exact fallback body (story-pinned). */
      unavailableBody: string;
      /** Intentional heading for a keyless /embed visit (not an outage). */
      missingKeyHeading: string;
      /** Intentional body for a keyless /embed visit (not an outage). */
      missingKeyBody: string;
      /** CTA label on the widget. */
      ctaLabel: string;
      /** Contact-line prefix; the builder's phone/email follow. */
      contactPrefix: string;
      /** "Powered by" badge text — non-removable in v1. */
      poweredBy: string;
      /**
       * Relay session strings (embed/06). Shown when the one-time relay code
       * has expired or was already used — the user gets a fresh link, never
       * a dead end.
       */
      sessionExpiredHeading: string;
      sessionExpiredBody: string;
      resendLinkLabel: string;
      /** Busy label on the fresh-link button while the re-issue is in flight. */
      resendLinkBusyLabel: string;
      /** Shown when the 60s per-code resend cooldown fires (embed/06 AC3). */
      resendCooldownBody: string;
    };
    /**
     * Wizard scope-step copy (S2 — FE-2). Step labels are structural;
     * everything user-facing stays tunable here. Tier `id`s must match the
     * FinishTier contract union; blurbs carry no prices, ever.
     */
    wizard: {
      stepAddress: string;
      stepScope: string;
      stepDetails: string;
      scopeHeading: string;
      scopeSqftLabel: string;
      scopeSqftHint: string;
      scopeSqftUnit: string;
      scopeTierLabel: string;
      scopeTierHint: string;
      scopeTiers: { id: FinishTier; name: string; blurb: string }[];
      /**
       * Garage selector (consumer/05): `id`s must match the GarageOption
       * contract union; blurbs carry no prices, ever.
       */
      scopeGarageLabel: string;
      scopeGarageHint: string;
      scopeGarages: { id: GarageOption; name: string; blurb: string }[];
      /**
       * Basement selector (consumer/05): `id`s must match the BasementOption
       * contract union; blurbs carry no prices, ever.
       */
      scopeBasementLabel: string;
      scopeBasementHint: string;
      scopeBasements: { id: BasementOption; name: string; blurb: string }[];
      scopeBackLabel: string;
      scopeCta: string;
      scopeEmpty: string;
      scopeEmptyCta: string;
      /**
       * Project-type selector (RENO-02): both cards enabled, no "coming soon".
       * `id`s must match the ProjectType union in the wizard actions.
       */
      scopeProjectTypeLabel: string;
      scopeProjectTypes: { id: 'new-build' | 'renovation'; name: string; blurb: string }[];
      /** Shown under the cards when Renovation is selected (no prices, ever). */
      renoSelectedNote: string;
      /** Placeholder for the reno scope-inputs step until RENO-03 builds it. */
      renoScopePendingTitle: string;
      renoScopePendingBody: string;
      renoScopeBackLabel: string;
      /** RENO-03 reno scope-inputs step copy. */
      renoScopeHeading: string;
      renoTypeLabel: string;
      renoTypes: { id: 'extensive' | 'addition' | 'basement' | 'combined'; name: string; blurb: string }[];
      renoSqftLabel: string;
      renoSqftHint: string;
      renoSqftUnit: string;
      renoAdditionCapNote: string;
      renoSqftClampNote: string;
      renoTierLabel: string;
      renoTierHint: string;
      renoUnderpinningLabel: string;
      renoUnderpinningBlurb: string;
      renoPermitNote: string;
      renoScopeCta: string;
      renoScopeEmpty: string;
      renoScopeEmptyCta: string;
      detailsLivingArea: string;
      detailsFinishTier: string;
      detailsGarage: string;
      detailsBasement: string;
      detailsPreviewCta: string;
      detailsEmpty: string;
      detailsEmptyCta: string;
      detailsBackLabel: string;
    };
    /**
     * Neighbourhood comparison flow copy (NBH-04): the landing entry card
     * and the /estimate/compare picker. Exact user-facing strings required
     * by the story live here — never hardcoded in templates.
     */
    comparison: {
      /** Landing entry card title: exact copy "Compare neighbourhoods". */
      landingTitle: string;
      /** Landing entry card body: exact copy "Side-by-side build costs for 2–3 Calgary communities." */
      landingBody: string;
      /** Picker page heading. */
      pickerHeading: string;
      /** Picker page subheading. */
      pickerSubheading: string;
      /** Community search input label. */
      searchLabel: string;
      /** Community search input placeholder. */
      searchPlaceholder: string;
      /** Shown when the search matches no communities. */
      searchNoResults: string;
      /** Selected-communities section label. */
      selectedLabel: string;
      /** Clears all selected communities. */
      clearAllLabel: string;
      /** Sqft section copy for the shared slider. */
      sqftLabel: string;
      sqftHint: string;
      sqftUnit: string;
      /** Tier section copy for the shared selector. */
      tierLabel: string;
      tierHint: string;
      /** Exact warning when a fourth community is picked: "You can compare up to 3 communities." */
      maxCommunitiesNote: string;
      /** CTA — exact copy "Compare →". */
      cta: string;
      /** Shown under the disabled CTA until 2 communities are selected. */
      ctaHint: string;
      /**
       * Interim confirmation (NBH-04 only): shown after the CTA until NBH-03
       * lands the real comparison result pipeline. Honest placeholder copy —
       * never pretends a result exists.
       */
      interimTitle: string;
      interimBody: string;
      interimBackLabel: string;
      /**
       * Comparison results (NBH-03): side-by-side cards + bar chart.
       * Exact user-facing strings required by the story live here — never
       * hardcoded in templates.
       */
      /** Results page heading. */
      resultsHeading: string;
      /** Summary line under the heading (sqft + tier filled by the component). */
      resultsSubheading: string;
      /** Exact label above each community's City-assessed figure. */
      assessedLabel: string;
      /** Visible pre-gate: the fixed land figure label (never a range). */
      landLabel: string;
      /** Blurred pre-gate: the build cost label. */
      buildLabel: string;
      /** Blurred pre-gate: the total figure label. */
      totalLabel: string;
      /**
       * Transparent total derivation shown under each total:
       * '{assessed}' + '{buildRange}'.
       */
      totalMathTemplate: string;
      /** Exact badge copy on the cheapest-land community: "Lowest land cost". */
      lowestLandBadge: string;
      /** Screen-reader / visible alternative where blurred figures sit. */
      lockedNote: string;
      /** Single unlock CTA — exact copy "Unlock Full Numbers →". */
      unlockCta: string;
      /** Returns to the picker with selections intact. */
      editLabel: string;
      /** Bar chart title. */
      chartTitle: string;
      /** Chart axis note: ranges per community, never $/sqft or margins. */
      chartAxisNote: string;
      /** Analyzing beat stage labels (each tied to a real awaited operation). */
      analyzingValidate: string;
      analyzingFetch: string;
      analyzingCalculate: string;
      /** Tier what-if (post-gate): re-runs every row-set inline. */
      whatIfLabel: string;
      whatIfHint: string;
    };
    /**
     * Estimate preview step (S5) copy — the single lead-gate point.
     * Figure labels, the locked note, and the one "Unlock" CTA live with the
     * report copy (single source); the loading/error/retry strings are reused
     * from there too. Nothing here may carry ±, %, or accuracy claims.
     */
    preview: {
      heading: string;
      readyNote: string;
      backLabel: string;
      /** BUG-6: reno preview goes back to the reno scope step, not "details". */
      renoBackLabel: string;
      /** RENO-04: reno-specific visible fact labels. */
      renoTypeLabel: string;
      renoSqftLabel: string;
      /**
       * Validation-failure explainer (consumer/06): shown when the preview
       * API rejects the request (e.g. assessed value out of range). Retry
       * cannot succeed, so no retry button — just a plain-English
       * explanation and a way back. Lot size NEVER blocks (Karan,
       * 2026-09-28): the engine prices any lot.
       */
      validationHeading: string;
      validationGenericBody: string;
      /**
       * Non-residential coverage explainer: shown when the City classifies
       * the parcel commercial/industrial. Takes precedence over the generic
       * body in the early coverage guard (landing + embed).
       */
      validationNonResidentialBody: string;
      /**
       * Unsupported-property-type coverage explainer: shown when the City
       * land-use designation is outside the single-family set the estimator
       * quotes (R-C2, R-CG, M-*, …). Takes precedence over the generic body,
       * after the non-residential check, in the early coverage guard
       * (landing + embed).
       */
      validationUnsupportedPropertyTypeBody: string;
      /**
       * Zoning-guide cross-link (SEO guides): shown under the
       * unsupported-property-type message, linking to the
       * "why Feasly only quotes single-family homes" FAQ anchor.
       */
      validationZoningGuideLink: string;
      validationBackLabel: string;
    };
    /** Property card (shared) copy. */
    propertyCard: {
      /**
       * Freshness line while the mock property harness serves the data
       * (`propertyData.source === 'mock'`): sample values must never
       * masquerade as City records (trust rule).
       */
      freshnessMock: string;
    };
    /**
     * Estimate report page copy. The hero shows ONE prominent total (the
     * engine's deterministic base) with a "Likely planning range" for
     * context — never Low/Base/High labels on the report itself. Nothing
     * here may carry ±, %, or accuracy claims (copy-linted).
     */
    report: {
      heading: string;
      subPreGate: string;
      subPostGate: string;
      totalLabel: string;
      /** "Likely planning range" — the supporting range under the hero total. */
      planningRangeLabel: string;
      buildLabel: string;
      /** Clarifier under the highlighted build-cost figure. */
      buildCostNote: string;
      /** Source label under the build-cost figure: data-driven trust. */
      buildSourceNote: string;
      landLabel: string;
      /** Fixed-figure explainer: City assessment, never a range. */
      landFixedNote: string;
      /** Unit-address honesty note: lot figures are for the whole building. */
      unitAddressNote: string;
      lowLabel: string;
      baseLabel: string;
      highLabel: string;
      uncalibratedNote: string;
      /** "How we calculate" expandable on the report — data-driven trust. */
      howWeCalculateTitle: string;
      howWeCalculateItems: string[];
      lockedNote: string;
      unlockCta: string;
      /** Post-gate confirmation line: the emailed link is return-access for other devices. */
      leadLinkNote: string;
      /** Duplicate-submit variant of the lead-link note: no new email was sent. */
      leadLinkNoteDuplicate: string;
      /**
       * Send-failure variant of the lead-link note: the lead was saved and
       * the report unlocked (reportToken present) but the magic-link email
       * failed to send — nudges the user to check their inbox or try again.
       */
      leadLinkNoteFailed: string;
      /**
       * Invalid-recipient variant: the address itself was rejected
       * (emailError === 'invalid-recipient') — asks the user to check for
       * typos instead of "check your inbox", which would never arrive.
       */
      leadLinkNoteInvalidRecipient: string;
      breakdownTitle: string;
      breakdownLocked: string;
      /** Display-only finish tier on the report ("Selected finish level — Standard"). */
      finishLevelLabel: string;
      /** Short honest descriptor of the selected finish tier (no prices). */
      tierDescriptors: { standard: string; premium: string; luxury: string };
      /** Upgrades-are-explicit-choices note under the tier descriptor. */
      tierChoicesNote: string;
      /** "What your estimate covers" — honest included/excluded framing. */
      coverageTitle: string;
      /** One-line "full build" framing above the exclusions list. */
      includedLine: string;
      /** Honest note: inflation, material choices, project conditions can move costs. */
      costMovementNote: string;
      /** "What's not in this estimate" heading. */
      exclusionsTitle: string;
      /** Honest exclusion list — landscaping only (Karan 2026-09-28: the estimate covers the full build except landscaping). */
      exclusions: string[];
      tierTitle: string;
      tierLockedNote: string;
      /** What-if toggle hint (report page, post-gate): instant-plain, mirrors adjustHint. */
      tierToggleHint: string;
      adjustTitle: string;
      decreaseLabel: string;
      increaseLabel: string;
      adjustHint: string;
      adjustUnit: string;
      adjustCta: string;
      adjustLockedNote: string;
      /** RENO: the size stepper becomes an affected-area stepper on reno reports. */
      adjustTitleReno: string;
      adjustHintReno: string;
      adjustLockedNoteReno: string;
      /** RENO: label for the renovation-type + affected-area scope line. */
      renoScopeLabel: string;
      /** Shown while a debounced sqft revision is in flight. */
      updatingLabel: string;
      /** "Updated {date}" — shown when an old magic link resolved to a newer snapshot (consumer/02). */
      updatedLabel: string;
      /** "$X per sq ft" context line under the build cost. */
      perSqftUnit: string;
      narrativeTitle: string;
      narrativeComingSoon: string;
      aiSummaryLocked: string;
      /** Shown post-gate when the AI narrative could not be produced — never mock text. */
      aiSummaryUnavailable: string;
      /** Title for the static Calgary guide shown when every narrative model failed (BE-9). */
      staticGuideTitle: string;
      /** Honest sub-note under the static guide title — never implies AI prose. */
      staticGuideNote: string;
      stepsTitle: string;
      steps: { id: string; title: string; body: string }[];
      /** Checklist progress line; `{done}` and `{total}` are the counts. */
      stepsProgress: string;
      /** "Planning ahead" card: financing + timeline honesty for prospects. */
      planningTitle: string;
      financingTitle: string;
      financingLines: string[];
      timelineTitle: string;
      timelineLine: string;
      shareTitle: string;
      shareHint: string;
      shareEmailLabel: string;
      shareCta: string;
      shareInvalid: string;
      /** Partner-share button label while the backend sends the email. */
      shareSending: string;
      /** Partner-share success copy; `{email}` is the recipient's address. */
      shareSent: string;
      /** Partner-share send failure (retry stays available on the button). */
      shareError: string;
      /**
       * Partner-share when the recipient address is the owner's own —
       * caught client-side before the backend's CAP-008 self-share 400.
       */
      shareSelfError: string;
      /** Partner share when the memory-only report token is gone. */
      shareTokenError: string;
      /** Partner-share button label after a send failure. */
      shareRetry: string;
      /**
       * Read-only banner on the report page when the session redeemed a
       * partner-share link (the stepper, share form, and callback form are
       * hidden in partner view).
       */
      partnerViewNote: string;
      callbackTitle: string;
      callbackHint: string;
      callbackNameLabel: string;
      callbackPhoneLabel: string;
      callbackWindowLabel: string;
      callbackWindows: { id: CallbackWindow; label: string }[];
      callbackCta: string;
      callbackSuccess: string;
      callbackError: string;
      callbackInvalid: string;
      pdfCta: string;
      pdfGenerating: string;
      pdfError: string;
      /** Inside the PDF: honest line when the AI narrative is empty. */
      pdfNarrativeFallback: string;
      /** Inside the PDF: '{sqft}' and '{tier}' template for the size/finishes row. */
      pdfInputsLine: string;
      loadingLabel: string;
      loadError: string;
      retryLabel: string;
      versionLabel: string;
      /** RENO-04: reno-specific report copy (exact copy required by AC). */
      renoPermitNote: string;
      renoDeterministicNote: string;
      estimateAnotherLabel: string;
    },
    /**
     * Lead-gate step (FE-004) copy. The single gate in the flow: name/email
     * required, phone/timeline optional, contact-consent checkbox required.
     */
    gate: {
      heading: string;
      sub: string;
      /** Quiet trust line under the gate subheading — data-driven, not a calculator. */
      trustLine: string;
      nameLabel: string;
      namePlaceholder: string;
      nameRequired: string;
      emailLabel: string;
      emailPlaceholder: string;
      emailRequired: string;
      emailInvalid: string;
      phoneLabel: string;
      phonePlaceholder: string;
      /** Short "(optional)" marker rendered beside optional labels. */
      optionalMarker: string;
      phoneInvalid: string;
      /** JS RegExp source for the optional phone field (no hardcode). */
      phonePattern: string;
      timelineLabel: string;
      /** RENO-06: reno variant of the timeline question, selected by projectType. */
      timelineLabelReno: string;
      timelinePlaceholder: string;
      /** Shown when the (required) timeline question is left unanswered. */
      timelineRequired: string;
      /** `id`s must match the TimelineOption contract union. */
      timelineOptions: { id: TimelineOption; label: string }[];
      /**
       * Required contact-consent checkbox (Karan 2026-09-27): Feasly and
       * builders associated with us may contact the lead about their
       * estimate; the lead can opt out anytime. Wording is a DRAFT pending
       * legal review — do not present as lawyer-approved.
       */
      consentLabel: string;
      /** Inline error when the required consent checkbox is unchecked. */
      consentRequired: string;
      privacyNote: string;
      privacyLinkLabel: string;
      submitLabel: string;
      submittingLabel: string;
      submitError: string;
      retryLabel: string;
      backLabel: string;
    };
    /**
     * Analyzing screen (FE-004) copy. Stages describe real pipeline work —
     * never fake progress.
     */
    analyzing: {
      heading: string;
      sub: string;
      stageValidate: string;
      stageFetch: string;
      stageEstimate: string;
      /** Screen-reader status words for each stage. */
      statusPending: string;
      statusActive: string;
      statusDone: string;
      statusError: string;
      errorHeading: string;
      errorBody: string;
      retryLabel: string;
      /** Back link out of the analyzing screen (the pipeline must never trap the user). */
      backLabel: string;
    };
    /** Renovation coming-soon page (reno out of launch scope, Karan 2026-09-27). */
    renoComingSoon: {
      heading: string;
      body: string;
      newBuildCta: string;
      /** Back link to the reno scope step. */
      backLabel: string;
    };
    /** Per-page SEO titles + descriptions (long literals live here, not in components). */
    seo: {
      landingTitle: string;
      landing: string;
      scopeTitle: string;
      scope: string;
      renoScopeTitle: string;
      renoScope: string;
      detailsTitle: string;
      details: string;
      previewTitle: string;
      preview: string;
      reportTitle: string;
      report: string;
      sampleReportTitle: string;
      sampleReport: string;
      gateTitle: string;
      gate: string;
      analyzingTitle: string;
      analyzing: string;
      renoComingSoonTitle: string;
      renoComingSoon: string;
      compareTitle: string;
      compare: string;
      privacyTitle: string;
      privacy: string;
      termsTitle: string;
      terms: string;
      howItWorksTitle: string;
      howItWorks: string;
      faqTitle: string;
      faq: string;
      pillarGuideTitle: string;
      pillarGuide: string;
      zoningGuideTitle: string;
      zoningGuide: string;
      developersTitle: string;
      developers: string;
      communitiesTitle: string;
      communities: string;
      notFoundTitle: string;
      notFound: string;
      unsubscribeTitle: string;
      unsubscribe: string;
      magicLinkTitle: string;
      magicLink: string;
      errorTitle: string;
      error: string;
      /** Admin console (admin/07): per-section titles for client-side nav. All noindexed. */
      adminHomeTitle: string;
      adminHome: string;
      adminLeadsTitle: string;
      adminLeads: string;
      adminBuildersTitle: string;
      adminBuilders: string;
      adminUsersTitle: string;
      adminUsers: string;
      adminDisputesTitle: string;
      adminDisputes: string;
      adminCalibrationTitle: string;
      adminCalibration: string;
      adminBillingTitle: string;
      adminBilling: string;
      adminSheetsTitle: string;
      adminSheets: string;
      adminEstimatesTitle: string;
      adminEstimates: string;
      adminApiKeysTitle: string;
      adminApiKeys: string;
      adminFunnelsTitle: string;
      adminFunnels: string;
      adminLoginTitle: string;
      adminLogin: string;
      adminCallbackTitle: string;
      adminCallback: string;
    };
    /**
     * Marketing pages (SEO-010). All user-facing copy for `/how-it-works`
     * and `/faq` lives here so the no-hardcode tripwire stays green and
     * copy is deploy-tunable. No accuracy guarantees, no "free forever"
     * claims — copy-linted by `tools/check-prerender-seo.mjs`.
     */
    marketing: {
      howItWorks: {
        eyebrow: string;
        title: string;
        sub: string;
        steps: { n: string; title: string; body: string }[];
        mathNoteTitle: string;
        mathNoteBody: string;
        ctaNewBuild: string;
        ctaReno: string;
        /** Zoning cross-link card (SEO guides): why the address/zoning matters. */
        zoningCardTitle: string;
        zoningCardBody: string;
        zoningCardCta: string;
      };
      faq: {
        eyebrow: string;
        title: string;
        sub: string;
        items: { q: string; a: string }[];
      };
      /**
       * Pillar guide (SEO pillar): long-form "cost to build a house in
       * Calgary" guide at `/guides/cost-to-build-a-house-calgary`.
       * Figures are planning ranges from the cost model — never accuracy
       * claims (banned-phrase tripwire).
       */
      pillarGuide: {
        eyebrow: string;
        title: string;
        lede: string;
        tiersTitle: string;
        tiersIntro: string;
        tiers: { name: string; range: string; blurb: string }[];
        exampleTitle: string;
        exampleBody: string;
        includedTitle: string;
        includedBody: string;
        excludedTitle: string;
        excludedBody: string;
        infillTitle: string;
        infillBody: string;
        financingTitle: string;
        financingBody: string;
        faqTitle: string;
        faqs: { q: string; a: string }[];
        mathNoteTitle: string;
        mathNoteBody: string;
        ctaEstimate: string;
        ctaCommunities: string;
      };
      /**
       * Zoning explainer (SEO guides): long-form "Calgary zoning explained"
       * guide at `/guides/calgary-zoning-explained`. Zone facts follow the
       * City of Calgary Land Use Bylaw 1P2007 — no invented designations.
       */
      zoningGuide: {
        eyebrow: string;
        title: string;
        lede: string;
        introTitle: string;
        introBody: string;
        tableTitle: string;
        tableIntro: string;
        tableHeaders: { zone: string; name: string; allows: string; build: string };
        zones: { code: string; name: string; allows: string; build: string }[];
        recentTitle: string;
        recentBody: string;
        lookupTitle: string;
        lookupBody: string;
        faqTitle: string;
        /** `anchor` is optional: deep-link target for cross-page links. */
        faqs: { q: string; a: string; anchor?: string }[];
        sourceTitle: string;
        sourceBody: string;
        sourceLinkLabel: string;
        sourceUrl: string;
        verifyNote: string;
        ctaEstimate: string;
        ctaCostGuide: string;
      };
      /**
       * Community index (SEO-05). Copy for `/communities/` and the landing
       * "Browse community guides" entry card.
       */
      communities: {
        /** Landing card title: "Browse community guides". */
        landingTitle: string;
        /** Landing card body. */
        landingBody: string;
        /** Index page intro paragraph. */
        intro: string;
      };
    };
    /**
     * Builder-matching explainer (UX audit 2026-09-28). The phrases
     * "builders associated with us" / "matched builder" appear on the gate,
     * report, and FAQ — this honest, buyer-grade explainer defines them in
     * one place so every surface links the same definition. No marketplace
     * promises: Feasly is an independent estimator.
     */
    builderMatching: {
      /** Expander summary, e.g. `What does "builders associated with us" mean?` */
      summary: string;
      /** Explainer paragraphs, rendered in order. */
      paragraphs: string[];
    };
    /**
     * Consent banner (story consumer/01). All user-facing banner copy lives
     * here so the no-hardcode tripwire stays green and copy is
     * deploy-tunable. No dark patterns: accept and decline are worded as
     * equal choices.
     */
    consent: {
      title: string;
      body: string;
      accept: string;
      decline: string;
    };
    /**
     * Legal pages (legal/01). Banner copy for the draft-pending-review
     * notice shown while `legal.reviewPending` is true. Story-pinned
     * wording — do not paraphrase.
     */
    legal: {
      /** Banner heading: "Draft — pending legal review". */
      reviewBannerHeading: string;
      /** Banner body explaining the draft status. */
      reviewBannerBody: string;
    };
    /**
     * Community pages (SEO-04). Static copy for `/communities/:slug/` —
     * the per-community figures come from the build-time JSON artifacts.
     * No accuracy guarantees, no sold-price claims.
     */
    communities: {
      /** Shown when the cost data is still uncalibrated. */
      illustrativeBanner: string;
      /** Title pattern; {name} is the community display name. */
      titleTemplate: string;
      /** Meta description pattern; {name} is the community display name. */
      descriptionTemplate: string;
      statLabel: string;
      statNote: string;
      basisNote: string;
      tierSectionTitle: string;
      tierSectionSub: string;
      /** Eyebrow above the hero total on each tier card. */
      totalLabel: string;
      /** Legend label for the land segment of the split bar. */
      landSplitLabel: string;
      /** Legend label for the build segment of the split bar. */
      buildSplitLabel: string;
      /**
       * aria-label template for the split bar (text equivalent, never
       * color-only). Placeholders: {land}, {landPct}, {build}, {buildPct}.
       */
      splitBarLabelTemplate: string;
      faqTitle: string;
      faqItems: { q: string; a: string }[];
      ctaTitle: string;
      ctaBody: string;
      ctaLabel: string;
      /**
       * Property-profile page variant copy (condo/apartment-dominated
       * communities). NOT in global config anymore — lives in
       * `app/features/communities/community-profile-copy.defaults.ts` and is
       * lazy-loaded with the profile variant (Lighthouse script-size budget).
       * The shape is CommunityProfileCopy in `@feasly/contracts`.
       */
      /** One-link cross-reference to the zoning explainer guide (SEO guides). */
      zoningGuideLink: string;
    };
    /**
     * Builder portal wiring. Only infrastructure config lives in the root
     * config now: the Entra tenant wiring is needed at startup (the Entra
     * auth service is root-provided). All user-facing builder-portal copy
     * moved to {@link BuilderCopy} — lazy-loaded with the builder portal
     * via BUILDER_COPY so it stays out of the initial bundle.
     */
    builder: {
      /** Builder Entra tenant wiring (infrastructure, not user copy). */
      entra: BuilderEntraConfig;
    };
    /**
     * Admin funnel dashboard (story admin/07). All user-facing dashboard
     * copy lives here so the no-hardcode tripwire stays green.
     */
    admin: {
      funnels: {
        /** Page heading. */
        title: string;
        /** Page subheading. */
        subtitle: string;
        /** Date-range "from" label. */
        fromLabel: string;
        /** Date-range "to" label. */
        toLabel: string;
        /** Tenant filter label. */
        tenantLabel: string;
        /** Tenant filter: all traffic. */
        tenantAll: string;
        /** Tenant filter: Feasly-direct only. */
        tenantDirect: string;
        /** Tenant filter: one embed tenant. */
        tenantKey: string;
        /** Tenant-key text input label. */
        tenantKeyLabel: string;
        /** Tenant-key text input placeholder. */
        tenantKeyPlaceholder: string;
        /** Apply-filters button. */
        apply: string;
        /** Reset-filters button. */
        reset: string;
        /** Loading indicator text. */
        loading: string;
        /** Empty funnel state. */
        empty: string;
        /** Fetch failure banner (static — no error detail in the DOM). */
        loadError: string;
        /** Invalid date range (from after to). */
        invalidRange: string;
        /** First-step conversion label. */
        entryStep: string;
        /** Conversion prefix before the percentage. */
        conversionPrefix: string;
        /** Shown when conversion is meaningless (first step / zero prior). */
        noConversion: string;
      };
      apiKeys: {
        title: string;
        subtitle: string;
        issueButton: string;
        issueTitle: string;
        nameLabel: string;
        namePlaceholder: string;
        tenantLabel: string;
        tenantPlaceholder: string;
        scopesLabel: string;
        rateLimitLabel: string;
        sandboxLabel: string;
        sandboxHint: string;
        createButton: string;
        cancelButton: string;
        copyButton: string;
        copiedButton: string;
        plaintextWarning: string;
        rotateButton: string;
        revokeButton: string;
        rotateConfirm: string;
        revokeConfirm: string;
        confirmYes: string;
        confirmNo: string;
        editButton: string;
        saveButton: string;
        usageTitle: string;
        usageLoading: string;
        usageEmpty: string;
        usageDateHeader: string;
        usageEndpointHeader: string;
        usageRequestsHeader: string;
        usageEstimatesHeader: string;
        loading: string;
        empty: string;
        loadError: string;
        revokedLabel: string;
        activeLabel: string;
        lastUsedLabel: string;
        createdLabel: string;
      };
      /**
       * Admin auth pages (auth/02 pivot): Entra sign-in + callback copy.
       * All user-facing strings live here so the no-hardcode tripwire
       * stays green and copy is deploy-tunable. Exact strings are pinned
       * by the login/callback specs.
       */
      auth: {
        /** Session-expired notice on the login page. */
        loginExpired: string;
        /** Label of the Entra "Sign in →" button. */
        entraSignInLabel: string;
        /** Intro line above the Entra button. */
        entraSignInIntro: string;
        /**
         * Callback failure when Entra reports `error=access_denied`
         * (user cancelled) or the callback carries no usable code.
         */
        entraIncomplete: string;
        /** Callback failure when the `state` param mismatches (CSRF). */
        entraStateMismatch: string;
        /** Network/5xx failure exchanging the code with the backend. */
        entraTransient: string;
        /** Shown when the Entra tenant config is still a placeholder. */
        entraNotConfigured: string;
      };
    };
    /**
     * Unsubscribe center (email/03) copy. The confirmation line
     * `doneHeading` is pinned by the story's acceptance criteria.
     */
    unsubscribe: {
      loadingLabel: string;
      preferencesHeading: string;
      preferencesBody: string;
      emailToggleLabel: string;
      emailToggleBody: string;
      contactToggleLabel: string;
      contactToggleBody: string;
      unsubscribeAllCta: string;
      saveCta: string;
      savingLabel: string;
      doneHeading: string;
      doneEmailsOff: string;
      doneEmailsOn: string;
      doneCallsOff: string;
      doneCallsOn: string;
      doneMagicLinkNote: string;
      resubscribePrompt: string;
      resubscribeBody: string;
      expiredHeading: string;
      expiredBody: string;
      expiredCta: string;
      invalidHeading: string;
      invalidBody: string;
      errorHeading: string;
      errorBody: string;
      retryLabel: string;
      homeCta: string;
    };
    /**
     * Magic-link redemption page (`/r/:token`, consumer/02) copy. All
     * user-facing strings live here so the no-hardcode tripwire stays green.
     * Partner-share tokens use the same `/r/` URL shape and verify on
     * GET /api/v1/shares/verify — the owner verify endpoint answers
     * invalid for them, and the page falls through to the partner path.
     */
    magicLink: {
      loadingLabel: string;
      invalidHeading: string;
      invalidBody: string;
      expiredHeading: string;
      expiredBody: string;
      errorHeading: string;
      errorBody: string;
      retryLabel: string;
      homeCta: string;
      resendPrompt: string;
      resendEmailLabel: string;
      resendEmailPlaceholder: string;
      resendEmailError: string;
      resendCta: string;
      resendingLabel: string;
      resendDoneHeading: string;
      resendDoneBody: string;
      resendErrorBody: string;
    };
  };
}
