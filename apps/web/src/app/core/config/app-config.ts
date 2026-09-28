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
      trustItems: string[];
      /**
       * Shown instead of `trustItems` while the mock property harness
       * serves the data (`propertyData.source === 'mock'`): sample values
       * must never claim live City data (trust rule).
       */
      trustItemsMock: string[];
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
      landLabel: string;
      /** Fixed-figure explainer: City assessment, never a range. */
      landFixedNote: string;
      lowLabel: string;
      baseLabel: string;
      highLabel: string;
      uncalibratedNote: string;
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
      tierTitle: string;
      tierLockedNote: string;
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
      steps: { title: string; body: string }[];
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
      };
      faq: {
        eyebrow: string;
        title: string;
        sub: string;
        items: { q: string; a: string }[];
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
    };
    /**
     * Builder portal (embed/09). All user-facing builder-portal copy lives
     * here so the no-hardcode tripwire stays green and copy is
     * deploy-tunable. Mirrors the admin login semantics (magic link, no
     * enumeration oracle, session expiry).
     */
    builder: {
      /** `/builder/login` heading. */
      loginHeading: string;
      /** Session-expired notice on the login page. */
      loginExpired: string;
      /** Shown after the magic-link request (always — no oracle). */
      loginSent: string;
      /** Email field label. */
      emailLabel: string;
      /** Email field placeholder. */
      emailPlaceholder: string;
      /** Invalid-email validation message. */
      emailInvalid: string;
      /** Submit button label. */
      submitLabel: string;
      /** Submit button label while the request is in flight. */
      sendingLabel: string;
      /** Generic submit-failure message. */
      submitError: string;
      /** Retry button label (submit failure). */
      retryLabel: string;
      /** `/builder/verify` heading. */
      verifyHeading: string;
      /** Verify in-progress copy. */
      verifyProgress: string;
      /** Verify-failed copy (expired/used/invalid token). */
      verifyError: string;
      /** Back-to-login button label on the verify error. */
      backToLoginLabel: string;
      /** Builder shell brand text. */
      shellBrand: string;
      /** Builder shell nav: dashboard link label. */
      shellNavDashboard: string;
      /** Sign-out button label. */
      signOutLabel: string;
      /** Dashboard heading. */
      dashboardHeading: string;
      /** Leads-loading status copy. */
      loadingLeads: string;
      /** Leads-load failure copy. */
      loadError: string;
      /** Empty pipeline copy. */
      emptyLeads: string;
      /** Pipeline filter label. */
      filterLabel: string;
      /** Pipeline filter "all statuses" option. */
      filterAllLabel: string;
      /** Pipeline copy when the active filter matches nothing. */
      emptyFilterLeads: string;
      /** Pipeline summary heading. */
      summaryHeading: string;
      /** Summary: total row label. */
      summaryTotal: string;
      /** Pipeline status labels, keyed by the BuilderLeadStatus union. */
      statusLabels: {
        new: string;
        contacted: string;
        quoted: string;
        won: string;
        lost: string;
      };
      /** Status-update 403 copy: the lead belongs to another tenant. */
      updateForbidden: string;
      /** Generic status-update failure copy. */
      updateFailed: string;
      /** Lead email field label. */
      leadEmailLabel: string;
      /** Lead address field label. */
      leadAddressLabel: string;
      /** Lead phone field label. */
      leadPhoneLabel: string;
      /** Lead timeline field label. */
      leadTimelineLabel: string;
      /** Lead score field label. */
      leadScoreLabel: string;
      /** Lead project-type field label. */
      leadProjectLabel: string;
      /** Lead created-date field label. */
      leadCreatedLabel: string;
      /** Lead status-updated timestamp label. */
      leadStatusUpdatedLabel: string;
      /** Status action group label (screen reader). */
      actionsLabel: string;
      /** Builder shell nav: billing link label. */
      shellNavBilling: string;
      /** `/builder/billing` heading. */
      billingHeading: string;
      /** Card-status loading copy. */
      billingLoading: string;
      /** Card-status load-failure copy. */
      billingLoadError: string;
      /** "No card on file" status copy. */
      billingNoCard: string;
      /** Card-on-file status line; {brand} {last4} {exp} are interpolated. */
      billingCardOnFile: string;
      /** "Add card" button label. */
      billingAddCard: string;
      /** "Update card" button label. */
      billingUpdateCard: string;
      /** Card form heading. */
      billingFormHeading: string;
      /** "Save card" submit label. */
      billingSaveCard: string;
      /** Submit label while Stripe confirms the setup. */
      billingSavingCard: string;
      /** Durable success copy after the card is saved. */
      billingCardSaved: string;
      /** Card-save failure copy. */
      billingSaveFailed: string;
      /** Copy when Stripe.js or the publishable key is unavailable. */
      billingUnavailable: string;
      /** "Cancel" button label (card form). */
      billingCancel: string;
      /** Explains the 1% commission charge timing. */
      billingExplainer: string;
      /** Builder billing tab: card-on-file section label. */
      billingTabCardLabel: string;
      /** Builder billing tab: invoices section label. */
      billingTabInvoicesLabel: string;
      /** `/builder/billing/invoices` heading. */
      invoicesHeading: string;
      /** Invoices list explainer. */
      invoicesExplainer: string;
      /** Invoices loading copy. */
      invoicesLoading: string;
      /** Invoices load-failure copy. */
      invoicesLoadError: string;
      /** Empty invoices list copy. */
      invoicesEmpty: string;
      /** Table header: invoice date. */
      invoicesColDate: string;
      /** Table header: signed contract value. */
      invoicesColContract: string;
      /** Table header: commission amount. */
      invoicesColCommission: string;
      /** Table header: invoice status. */
      invoicesColStatus: string;
      /** Table header: review deadline. */
      invoicesColDue: string;
      /** Status pill: draft. */
      invoiceStatusDraft: string;
      /** Status pill: in review. */
      invoiceStatusInReview: string;
      /** Status pill: finalized. */
      invoiceStatusFinalized: string;
      /** Status pill: paid. */
      invoiceStatusPaid: string;
      /** Status pill: failed. */
      invoiceStatusFailed: string;
      /** Status pill: disputed. */
      invoiceStatusDisputed: string;
      /** Status pill: void. */
      invoiceStatusVoid: string;
      /** Review-deadline countdown; {days} is interpolated. */
      invoicesAutoChargeIn: string;
      /** Review deadline is tomorrow. */
      invoicesAutoChargeTomorrow: string;
      /** Review deadline is today. */
      invoicesAutoChargeToday: string;
      /** Failed-charge banner copy. */
      invoicesPaymentFailed: string;
      /** Successful-charge banner copy. */
      invoicesPaymentReceived: string;
      /** "Update your card" CTA label. */
      invoicesUpdateCardCta: string;
      /** Back-to-list link label. */
      invoicesBackToList: string;
      /** Invoice detail: receipt section heading. */
      invoicesReceiptHeading: string;
      /** Invoice detail: line-items section heading. */
      invoicesLineItemsHeading: string;
      /** Invoice detail: status timeline heading. */
      invoicesTimelineHeading: string;
      /** Line-item row: signed contract value (excl. land). */
      invoicesContractRow: string;
      /** Line-item row: commission row label; {rate} is interpolated. */
      invoicesCommissionRow: string;
      /** Receipt row: amount charged. */
      invoicesReceiptAmount: string;
      /** Receipt row: charge date. */
      invoicesReceiptDate: string;
      /** Receipt row: card used. */
      invoicesReceiptCard: string;
      /** Review-window explainer on the detail view; {date} interpolated. */
      invoicesReviewNote: string;
      /** Pagination: previous page. */
      invoicesPrevPage: string;
      /** Pagination: next page. */
      invoicesNextPage: string;
      /** Pagination status; {page} and {pages} are interpolated. */
      invoicesPageOf: string;
      /** Timeline event: invoice created. */
      invoicesTimelineCreated: string;
      /** Timeline event: review window ends. */
      invoicesTimelineReviewEnds: string;
      /** Timeline event: finalized. */
      invoicesTimelineFinalized: string;
      /** Timeline event: paid. */
      invoicesTimelinePaid: string;
      /** Timeline event: charge failed. */
      invoicesTimelineFailed: string;
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
