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
import type { CallbackWindow, FinishTier, TimelineOption } from '@feasly/contracts';

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
   * Admin dashboard wiring (api-mcp/02).
   *
   * INTERIM: until admin/01 (magic-link admin session auth) lands, admin
   * routes authenticate with the `X-Admin-Key` header. Empty string = admin
   * routes are locked (the admin guard redirects to /). Deploy config only —
   * never commit a real key.
   */
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
  };
  /** Analytics consent. */
  analytics: {
    enabled: boolean;
    /** Exact opt-in wording shown to the user. */
    optInWording: string;
  };
  /** User-facing copy, namespaced by area. Extended by FE1-001. */
  /**
   * INTERIM: until admin/01 (magic-link admin session auth) lands, admin
   * routes authenticate with the `X-Admin-Key` header. Empty string = admin
   * routes are locked (the admin guard redirects to /). Deploy config only —
   * never commit a real key.
   */
  admin: {
    /** Pre-shared key sent as `X-Admin-Key`. Empty = locked. */
    adminKey: string;
    /** Default per-minute rate limit prefilled in the issue form. */
    defaultRateLimit: number;
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
    };
    /** Address-autocomplete strings, shared by landing (S0) and wizard (S1). */
    search: {
      label: string;
      placeholder: string;
      submitLabel: string;
      /** Shown when submitting with fewer than 3 characters typed. */
      emptyHint: string;
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
      /** CTA label on the widget. */
      ctaLabel: string;
      /** Contact-line prefix; the builder's phone/email follow. */
      contactPrefix: string;
      /** "Powered by" badge text — non-removable in v1. */
      poweredBy: string;
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
      pendingSub: string;
      pendingNote: string;
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
      stepsTitle: string;
      steps: { title: string; body: string }[];
      shareTitle: string;
      shareHint: string;
      shareEmailLabel: string;
      shareCta: string;
      shareInvalid: string;
      /** mailto: subject prefix for the email-draft share. */
      shareSubject: string;
      /**
       * mailto: body template for the email-draft share. `{tokens}` are filled
       * from the current snapshot (figures) and sibling report copy (labels),
       * so every label stays individually tunable via config.
       */
      shareBodyTemplate: string;
      /** Closing line of the mailto: body. */
      shareBodyClose: string;
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
     * required, phone/timeline optional, CASL opt-in unchecked by default.
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
      /** `id`s must match the TimelineOption contract union. */
      timelineOptions: { id: TimelineOption; label: string }[];
      /** Plain-language CASL opt-in; the box starts unchecked. */
      caslLabel: string;
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
      /** RENO-04: reno-specific step labels (each maps 1:1 to a real awaited call). */
      stageFetchReno: string;
      stageScopeReno: string;
      stageEstimateReno: string;
      stagePreviewReno: string;
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
      errorTitle: string;
      error: string;
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
    };
    admin: {
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
    };
  };
}
