import type { AppConfig } from './app-config';
import { ZONING_ELIGIBILITY } from './zoning-eligibility.generated';

/**
 * Compiled fallback configuration.
 *
 * This is the ONLY place in `src/app` where tunable literals may live, and it
 * exists so the app degrades gracefully instead of white-screening when
 * `/assets/config/app-config.json` is missing or malformed (e.g. a bad deploy).
 * Every value here must mirror `public/assets/config/app-config.json`,
 * EXCEPT `site.url`: the JSON ships `""` ("use the request origin at runtime")
 * while this file keeps the `https://feasly.com` placeholder so prerendered
 * HTML still emits absolute tags. See `apps/web/SEO.md` for the SITE_URL story.
 *
 * Changing behavior = editing the JSON, never this file.
 * Allowlisted in tools/hardcode-allowlist.txt.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  site: {
    // PLACEHOLDER — the production domain is undecided (feasly.com unverified).
    // Prerender fallback only: at runtime the JSON's "" wins and SeoService
    // uses the request origin. Swap when Karan confirms the domain (SEO.md).
    url: 'https://feasly.com',
    name: 'Feasly',
    socialImage: '/assets/og/og-default.png',
  },
  api: {
    baseUrl: '',
    useMockApi: true,
    timeoutMs: 15000,
    // The gate submit waits on the synchronous email send (worst case ~20s
    // with in-code retries) — 25s gives it headroom without raising the
    // timeout for every other API call.
    gateTimeoutMs: 25000,
    // Bulk CSV export on a cold Function can exceed the standard 15s timeout.
    exportTimeoutMs: 60000,
    // Give the browser a task to start the download before the blob URL dies
    // (synchronous revoke aborts downloads in Safari/WebKit).
    downloadRevokeDelayMs: 1000,
  },
  // Stripe publishable key is deploy-provided (see the deploy config JSON);
  // empty here = the card form stays unavailable until a deploy provides it.
  billing: {
    stripePublishableKey: '',
    questionInvoiceHref: '',
    chargeDelayDays: 7,
  },
  propertyData: {
    source: 'backend',
    baseUrl: 'https://data.calgary.ca',
    datasetId: '4bsw-nn7w',
    searchRowLimit: 50,
    cacheTtlMs: 300000,
  },
  features: {
    // Q4 unconfirmed (Karan): the slot renders only when this is true AND a
    // sample report route exists — never a dead link.
    sampleReport: false,
    // #520 (D-P4, owner 2026-11-15): Renovation is "Coming soon" on the
    // scope step with an email capture; other cities get a notify-me.
    renovationWaitlist: true,
    cityWaitlist: true,
    // #706/#806: the API now emails the erase-confirmation link, so the
    // page says "check your email" instead of offering an in-page delete.
    privacyEraseConfirmInPage: false,
  },
  // legal/01 AC3: draft until the lawyer reviews and approves the
  // privacy/terms copy. Flip to false only together with removing every
  // `draft-pending-lawyer` marker (the HRD-05 gate checks both).
  legal: {
    reviewPending: true,
  },
  wizard: {
    sqftDefault: 2200,
    sqftMin: 1200,
    sqftMax: 4000,
    sqftStep: 50,
    renoSqftDefault: 800,
    renoSqftMin: 200,
    renoSqftMax: 3000,
    renoSqftStep: 50,
    renoAdditionCap: 400,
  },
  timings: {
    debounceMs: 250,
    reviseDebounceMs: 400,
    filterDebounceMs: 250,
    resendCooldownSec: 60,
    mockLatencyMinMs: 400,
    mockLatencyMaxMs: 900,
    /** Analyzing pipeline: an API stage that takes longer than this fails honestly instead of hanging. */
    analyzingTimeoutMs: 20000,
    /** Portal UI kit Toast auto-dismiss (portal-ui-kit §3). */
    toastDurationMs: 5000,
  },
  limits: {
    communityPageLimit: 24,
    autocompleteSuggestionLimit: 6,
    communitySuggestionLimit: 4,
    /**
     * Mirror of the cost-data inputBounds
     * (packages/cost-engine/cost-data/v0.4.1-uncalibrated.json). The property
     * record arrives direct from Socrata, so the client needs the
     * assessed-value bounds for the early coverage guard.
     * `minLotSizeSqft`/`maxLotSizeSqft` are RESERVED for future bigger-lot
     * calibration (Karan, 2026-09-28) — NOT enforced anywhere; the estimator
     * never blocks on lot size. estimate-input-bounds-drift.spec.ts fails CI
     * if the values diverge — update both together.
     */
    minLotSizeSqft: 1200,
    maxLotSizeSqft: 20000,
    minAssessedLandValue: 25000,
    maxAssessedLandValue: 10000000,
    /**
     * Display rounding step for estimate figures (#504, #608). Mirror of the
     * cost-data top-level `roundTo` — the drift spec keeps them equal.
     */
    estimateRoundingStep: 1000,
  },
  buildTimeline: {
    defaultCity: 'calgary',
    cities: {
      // Owner decision (Karan, 2026-11-15, #823): a custom infill build
      // typically takes 12–16 months from design through permits to
      // completion. Phase ranges are typical and overlap (design wraps up
      // while the development permit is in review), so the total is set
      // here, never summed. Permit phases can later use real City approval
      // times from the permits story.
      calgary: {
        totalMinMonths: 12,
        totalMaxMonths: 16,
        phases: [
          { id: 'design', label: 'Design and architecture', min: 2, max: 4, unit: 'months' },
          { id: 'development-permit', label: 'Development permit', min: 2, max: 4, unit: 'months' },
          { id: 'building-permit', label: 'Building permit', min: 1, max: 2, unit: 'months' },
          { id: 'demolition', label: 'Demolition', min: 2, max: 4, unit: 'weeks' },
          { id: 'construction', label: 'Construction', min: 7, max: 10, unit: 'months' },
          { id: 'completion', label: 'Final inspections and completion', min: 2, max: 4, unit: 'weeks' },
        ],
      },
    },
  },
  coverage: {
    singleFamilyDistricts: {
      /**
       * Derived from the zoning catalogue (#911, owner decision 2026-11-15):
       * every district with a cited single-detached use, permitted or
       * discretionary, plus 'DC' (Direct Control, fail-open: common on
       * new-community greenfield lots). Generated by
       * packages/zoning/tools/gen-web-eligibility.ts; never edit by hand.
       * A district with no cited entry (e.g. R-CGex) is not quoted until a
       * cited entry is added to the catalogue.
       */
      calgary: ZONING_ELIGIBILITY.calgary.quotable,
    },
    discretionarySingleFamilyDistricts: {
      /** Subset where single-detached is discretionary (needs City approval). */
      calgary: ZONING_ELIGIBILITY.calgary.discretionary,
    },
  },
  deepLink: {
    addressMinLength: 3,
    addressMaxLength: 120,
    sources: ['community-lots', 'community-profile', 'guide', 'email', 'paid-search', 'share', 'site-search'],
    siteSearchSource: 'site-search',
  },
  analytics: {
    enabled: false,
    optInWording: 'Allow anonymous usage analytics to help improve Feasly.',
  },
  // #830: 25% of page loads report vitals + JS errors (free-tier volume
  // estimate: docs/ops/web-telemetry.md). maxBatchItems mirrors the API cap.
  telemetry: {
    enabled: true,
    sampleRate: 0.25,
    maxErrorsPerSession: 10,
    maxMessageLength: 300,
    maxBatchItems: 25,
  },
  admin: {
    defaultRateLimit: 60,
    rateLimitMax: 10000,
    apiKeyNameMax: 120,
    // Per-deploy: the served app-config.json sets it (empty hides the chip).
    environmentLabel: '',
    leads: { quotingStaleDays: 7 },
    quarantine: { bulkConcurrency: 4 },
    searchMaxQueryLength: 100,
    /**
     * Microsoft Entra External ID (auth/02 pivot). Placeholders — the
     * backend team provides the real tenant values (ENTRA_TENANT_SUBDOMAIN,
     * ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_USER_FLOW) in the deployed
     * app-config.json.
     */
    entra: {
      tenantSubdomain: 'ENTRA_TENANT_SUBDOMAIN',
      tenantId: 'ENTRA_TENANT_ID',
      clientId: 'ENTRA_CLIENT_ID',
      userFlow: 'ENTRA_USER_FLOW',
      authorizeUrlTemplate:
        'https://{tenantSubdomain}.ciamlogin.com/{tenantId}/oauth2/v2.0/authorize',
    },
  },
  copy: {
    tagline: 'Know what your new home build will cost — before you commit.',
    narrativeDisclaimer:
      'Dollar figures are calculated deterministically from our cost model — not generated by AI.',
    landing: {
      eyebrow: 'Calgary New Home Builds · Free Cost Estimates',
      heroTitle: 'What will it really cost to build your home in Calgary?',
      heroSub:
        'A free range-based estimate for your Calgary new home build — land, build, and total investment — in under 2 minutes.',
      seoDescription:
        'Feasly estimates what it really costs to build a home in Calgary, Alberta — based on City property records and current construction cost data.',
      trustItems: [
        { value: '600,000+', label: 'City of Calgary assessment records' },
        // Rewritten at runtime into the shared freshness line
        // (copy.dataFreshness, #513) from GET /api/v1/city-data/freshness;
        // value/label are the honest fallbacks while it is unknown —
        // never a hardcoded year or month that goes stale.
        {
          key: 'city-data-freshness',
          value: 'Live City data',
          valueShort: 'Live City data',
          label: 'City of Calgary assessment roll',
        },
        { value: 'Same fixed formula', label: 'AI never invents prices', badge: true },
      ],
      trustItemsMock: [
        { value: 'Range-based', label: 'estimates' },
        { value: 'Sample property data', label: 'live City records coming soon' },
        { value: 'Transparent', label: 'cost breakdown' },
      ],
      trustEyebrow: 'Why Feasly',
      howItWorksTitle: 'Estimate in 2 minutes',
      howItWorksSub: 'No spam — we may reach out about your estimate, and you can opt out anytime.',
      steps: [
        {
          n: '01',
          title: 'Enter your Calgary address',
          body: 'We pull the City property record — lot size, zoning, and assessed value.',
        },
        {
          n: '02',
          title: 'Configure your scope',
          body: 'Square footage, finish tier, garage, and basement. Approximate figures are fine.',
        },
        {
          n: '03',
          title: 'Get your full report',
          body: 'A range-based estimate with an AI summary, risk factors, and a downloadable PDF.',
        },
      ],
      sampleReportLabel: 'See a sample report →',
      seoSections: {
        costFactorsTitle: 'What drives the cost to build in Calgary',
        costFactorsBody:
          'The new home construction cost in Calgary comes down to three things: the land (your community\u2019s average City-assessed value), the build (square footage and Standard, Premium, or Luxury finishes), and the site (garage, basement, and lot conditions). Feasly prices all three from real data \u2014 so your new home cost estimate reflects the lot you\u2019re actually looking at.',
        renoTitle: 'Planning a renovation?',
        renoBody:
          'Renovation cost estimates are coming soon — built the same honest way as our new-build estimates, with real City data and the same fixed formula. New-build estimates are live today.',
        buildersTitle: 'For Calgary home builders',
        buildersBody:
          'Whether you’re a luxury home builder or an infill specialist, embed Feasly’s estimator on your own site and turn visitors into qualified leads. White-label ready, with a versioned API and the same deterministic cost engine.',
        buildersCta: 'Explore the developer docs →',
      },
    },
    search: {
      label: 'Your Calgary address',
      placeholder: 'Start typing your street number…',
      submitLabel: 'Get My Estimate →',
      emptyHint: 'Enter your Calgary address above to get started.',
      selectHint: 'Please choose your address from the suggestions above.',
      // U3 (2026-09-28): no-results is a guidance state, not a dead end —
      // typing a complete address finds nothing; the working path is typing
      // the street number and picking a suggestion from the list.
      noResults:
        "We couldn't find that address. Start typing the street number and pick your address from the list.",
      // #701: specific no-results hints, picked by what the user typed.
      noResultsPostalCode:
        "We can't search by postal code. Search by street address, for example 1412 Prospect Av SW.",
      noResultsNoHouseNumber: 'Start with the house number, for example 1412 Prospect Av SW.',
      noResultsUnit:
        "We couldn't find that unit. Condos and suites are listed by the building's street address, so try the building address on its own and pick from the list. You'll see the City's record for that address.",
      outOfCoverageHeading: 'We only support Calgary right now.',
      outOfCoverageBody:
        "Feasly's cost data covers Calgary addresses only. Try a Calgary address to continue.",
      // B11 (#514): coverage is deterministic, so the action is never "Retry" —
      // it clears and focuses the input for a fresh Calgary address.
      outOfCoverageAction: 'Try a Calgary address',
      error: 'Address search is temporarily unavailable. Please try again in a moment.',
      retryLabel: 'Retry',
      searchingLabel: 'Searching addresses…',
      siteSearchLabel: 'Search an address or community',
      siteSearchPlaceholder: 'Address or community',
      communitiesGroupLabel: 'Communities',
      addressesGroupLabel: 'Addresses',
      communityOptionHint: 'Community guide',
    },
    embed: {
      widgetLabel: 'Home building cost estimator',
      loadingLabel: 'Loading estimator…',
      unavailableHeading: 'Estimator unavailable',
      unavailableBody:
        'This estimator is temporarily unavailable — please contact the builder directly.',
      missingKeyHeading: 'This estimator needs a builder link',
      missingKeyBody:
        'This embed link is missing its builder key. Please open the estimator from your builder’s website instead of visiting this page directly.',
      ctaLabel: 'Get My Estimate →',
      contactPrefix: 'Questions?',
      poweredBy: 'Powered by Feasly',
      sessionExpiredHeading: 'This link has expired',
      sessionExpiredBody:
        'For your security, report links are single-use and expire after 10 minutes. Tap below to get a fresh link.',
      resendLinkLabel: 'Get a fresh link',
      resendLinkBusyLabel: 'Getting a fresh link…',
      resendCooldownBody:
        'A fresh link was just issued — please wait a minute and try again.',
    },
    wizard: {
      stepAddress: 'Address',
      stepScope: 'Your home',
      stepEstimate: 'Estimate',
      scopeHeading: 'Configure your build scope',
      scopeSqftLabel: 'Living area',
      scopeSqftHint:
        'Approximate above-grade living area. Most Calgary new home builds land between 1,800 and 3,500 sq ft — a rough number is fine.',
      scopeSqftUnit: 'sq ft',
      scopeTierLabel: 'Finish tier',
      scopeTierHint:
        'The level of finishes throughout the home. It shapes the estimate range — there are no prices on this page.',
      scopeTiers: [
        {
          id: 'standard',
          name: 'Standard',
          blurb:
            'Quality finishes throughout — finishes are never compromised, with fewer premium upgrades. Standard (non-oak) cabinetry, 9 ft basement ceilings.',
        },
        {
          id: 'premium',
          name: 'Premium',
          blurb:
            'A clear step up in every room: hardwood and tile, stone counters, upgraded cabinetry, and designer fixtures.',
        },
        {
          id: 'luxury',
          name: 'Luxury',
          blurb:
            'Oak kitchen cabinetry, 10 ft ceilings, outdoor fireplace, feature walls, and a fully finished basement — including the gym.',
        },
      ],
      scopeGarageLabel: 'Garage',
      scopeGarageHint:
        'The garage shapes the foundation and framing cost — pick the one that matches your plan.',
      scopeGarages: [
        {
          id: 'none',
          name: 'No garage',
          blurb:
            'No built-in garage. Keeps the build simpler and leaves more of the lot untouched.',
        },
        {
          id: 'double',
          name: 'Double garage',
          blurb:
            'The Calgary standard — room for two vehicles plus storage along the walls.',
        },
        {
          id: 'triple',
          name: 'Triple garage',
          blurb:
            'Three bays for extra vehicles, a workshop, or generous storage.',
        },
      ],
      scopeBasementLabel: 'Basement',
      scopeBasementHint:
        'Unfinished costs less today; finished adds living space from day one. Either way the foundation is the same.',
      scopeBasements: [
        {
          id: 'unfinished',
          name: 'Unfinished',
          blurb:
            'Basic foundation walls with rough-ins. Finish it later whenever you are ready.',
        },
        {
          id: 'finished',
          name: 'Finished',
          blurb:
            'Fully developed living space — bedrooms, bath, and family room from move-in day.',
        },
      ],
      scopeBackLabel: '← Back to address',
      scopeCta: 'See My Preview →',
      scopeEmpty: 'No address selected yet.',
      scopeEmptyCta: 'Find your address to start →',
      scopeProjectTypeLabel: 'What are you planning?',
      scopeProjectTypes: [
        {
          id: 'new-build',
          name: 'New Build',
          blurb:
            'A brand-new home on your lot, from foundation to finishes.',
        },
        {
          id: 'renovation',
          name: 'Renovation',
          blurb:
            'Remodel, addition, or basement work on your existing home.',
        },
      ],
      renoSelectedNote:
        'You will describe your renovation — type, area, and finishes — on the next step.',
      renoComingSoonBadge: 'Coming soon',
      renoNewBuildCta: 'Start a new-build estimate instead',
      steerRenovationReason: 'This home was built in {year}, so renovation is usually the better fit.',
      steerNewBuildReason: 'This home was built in {year}, so a new build is usually worth a look.',
      steerOverrideCta: 'Estimate a new build anyway',
      renoScopePendingTitle: 'Renovation scope',
      renoScopePendingBody:
        'Renovation scope inputs arrive in the next build. Your project type is saved — come back soon.',
      renoScopeBackLabel: '← Back to project type',
      renoScopeHeading: 'Describe your renovation',
      renoTypeLabel: 'What kind of renovation?',
      renoTypes: [
        {
          id: 'extensive',
          name: 'Extensive remodel',
          blurb: 'Gutting and rebuilding interior spaces — kitchen, baths, whole floors.',
        },
        {
          id: 'addition',
          name: 'Addition',
          blurb: 'Adding new living space to your home (up to 400 sq ft).',
        },
        {
          id: 'basement',
          name: 'Basement',
          blurb: 'Finishing or remodeling your basement.',
        },
        {
          id: 'combined',
          name: 'Combined',
          blurb: 'Kitchen + bath + basement together as one project.',
        },
      ],
      renoSqftLabel: 'Affected area',
      renoSqftHint: 'How many square feet are you renovating?',
      renoSqftUnit: 'sq ft',
      renoAdditionCapNote:
        'Additions over 400 sq ft are quoted as custom projects — enter 400 for the closest estimate.',
      renoSqftClampNote: 'Adjusted to the allowed range.',
      renoTierLabel: 'Finish tier',
      renoTierHint: 'The level of finishes for your renovation.',
      renoUnderpinningLabel: 'Include underpinning (lowering the basement floor)',
      renoUnderpinningBlurb: 'Structural work to increase basement ceiling height.',
      renoPermitNote:
        'Most renovations need a City permit and a 10–15% contingency — your report breaks both out.',
      renoScopeCta: 'See My Preview →',
      renoScopeEmpty: 'No address selected yet.',
      renoScopeEmptyCta: 'Find your address to start →',
    },
    comparison: {
      landingTitle: 'Compare neighbourhoods',
      landingBody: 'Side-by-side build costs for 2–3 Calgary communities.',
      pickerHeading: 'Compare neighbourhoods',
      pickerSubheading: 'Pick 2–3 Calgary communities to compare side-by-side build costs.',
      searchLabel: 'Find a community',
      searchPlaceholder: 'Search Calgary communities…',
      searchNoResults: 'No communities match your search.',
      selectedLabel: 'Selected communities',
      clearAllLabel: 'Clear all',
      sqftLabel: 'Living area',
      sqftHint: 'Approximate finished square footage for the comparison.',
      sqftUnit: 'sq ft',
      tierLabel: 'Finish tier',
      tierHint: 'Pick the finish level for the comparison.',
      maxCommunitiesNote: 'You can compare up to 3 communities.',
      cta: 'Compare →',
      ctaHint: 'Select at least 2 communities to compare.',
      interimTitle: 'Your comparison is on its way',
      interimBody:
        'We are building the side-by-side comparison for your communities. Check back soon — your picks are saved.',
      interimBackLabel: '← Adjust my picks',
      resultsHeading: 'Side-by-side comparison',
      resultsSubheading: '{count} Calgary communities · {sqft} · {tier}',
      assessedLabel: 'Average City-assessed value (not market value)',
      landLabel: 'Land (assessed value)',
      buildLabel: 'Build cost',
      totalLabel: 'Total',
      totalMathTemplate: '{assessed} + {buildRange}',
      lowestLandBadge: 'Lowest land cost',
      // Locked-slot note (QA 2026-10-04): there is no email-verification
      // step — unlock is a lead-gate submit, and the report unlocks
      // immediately (magic link = return access only). Matches the
      // report's framing ("Revealed when you get your free report").
      // "Unlock" is reserved for the single preview CTA (copy.report.unlockCta,
      // issue #506) — enforced by tools/check-banned-phrases.mjs.
      lockedNote: 'Revealed when you get your free report.',
      unlockCta: 'Show my free comparison →',
      editLabel: '← Edit communities',
      chartTitle: 'Total cost comparison',
      chartAxisNote: 'Bars show the likely total range per community.',
      analyzingValidate: 'Checking your communities…',
      analyzingFetch: 'Fetching City assessed values…',
      analyzingCalculate: 'Calculating side-by-side costs…',
      whatIfLabel: 'What if you change the finish?',
      whatIfHint: 'Re-runs every community at the new finish tier.',
    },
    preview: {
      heading: 'Your estimate preview',
      readyNote: 'Your numbers are ready.',
      backLabel: '← Back to scope',
      recapEditLabel: 'Edit',
      recapEditAriaLabel: 'Edit your home details',
      recapSqftUnit: 'sq ft',
      validationHeading: 'We can’t price this property yet',
      validationGenericBody:
        'One of the details for this property falls outside the range our cost data covers, so we can’t generate an estimate for it yet. Try a different address.',
      validationNonResidentialBody:
        'This looks like a commercial or industrial property — Feasly only prices residential Calgary homes right now.',
      validationUnsupportedPropertyTypeBody:
        'This property isn’t a single-family home — our estimator only quotes single-family new builds in Calgary right now.',
      validationZoningGuideLink: 'Learn about Calgary zoning →',
      validationBackLabel: '← Try a different address',
    },
    dataFreshness: {
      rollTemplate: '{year} assessment roll',
      rollUnknownYear: 'Current assessment roll',
      detailTemplate: '(City of Calgary) · checked {monthYear}',
      detailUnchecked: '(City of Calgary)',
    },
    propertyCard: {
      freshnessMock: 'Sample data for illustration — live City records coming soon',
      discretionaryZoningNote: 'Single-detached is a discretionary use here, so it needs City approval.',
    },
    report: {
      heading: 'Your build estimate',
      subPreGate: 'Your free preview is ready — get your free report to see the full numbers.',
      subPostGate: 'Your personalized build estimate for this Calgary property.',
      totalLabel: 'Total investment',
      mostLikelyLabel: 'Most likely ≈',
      mostLikelyPdfLabel: 'Most likely about',
      buildLabel: 'Build cost',
      buildCostNote: 'Construction only — excludes land.',
      buildSourceNote: 'Current construction cost data · same fixed formula',
      // Honest land label (consumer review M2, #505): the City's assessed
      // value covers the lot AND the existing house, not bare land.
      landLabel: 'City-assessed property value (land + existing home)',
      landHouseNote: 'Includes the current house; teardown value may differ.',
      landFixedNote: 'City of Calgary assessment · not a market price',
      unitAddressNote:
        'This looks like a unit address — the lot size and land value shown are for the whole building, not just your unit.',
      lowLabel: 'Low',
      baseLabel: 'Base',
      highLabel: 'High',
      uncalibratedNote:
        "How we're sharpening these numbers: we're calibrating against real Calgary builder quotes — your range already reflects current cost data and your City property record.",
      howWeCalculateTitle: 'How we calculate your estimate',
      howWeCalculateItems: [
        'Your City of Calgary property record — lot size, zoning, and assessed land value.',
        'Current construction cost data for Calgary builds.',
        'Deterministic math — our AI writes the summary only; it never invents prices.',
        'A planning range, not a single number — because your finish choices move the number.',
      ],
      lockedNote: 'Revealed when you get your free report.',
      unlockCta: 'Unlock my free report →',
      // Post-gate confirmation line (Karan directive 2026-09-27): the
      // magic-link email is return-access for other devices now, not the
      // unlock key — the report is already unlocked. Persistent, subtle.
      leadLinkNote: 'Report saved — we emailed you a link to reopen it anytime.',
      // Shown instead of leadLinkNote when the gate POST was a duplicate and
      // the backend sent no new email (magicLinkSent === false).
      leadLinkNoteDuplicate: 'Report saved — your link is already in your inbox.',
      // Shown instead of leadLinkNote when the gate POST saved the lead and
      // unlocked the report but the magic-link email failed to send
      // (magicLinkSent === false with a reportToken present). Karan
      // directive 2026-09-27: never a dead end — the user can check their
      // inbox or simply resubmit to retry the send.
      leadLinkNoteFailed:
        "Your estimate is saved, but we couldn't send the email link. Check your inbox — or try again later.",
      // Shown instead of leadLinkNoteFailed when the email failed because
      // the address itself was rejected (emailError === 'invalid-recipient',
      // Karan 2026-09-27): no "check your inbox" — it will never arrive.
      leadLinkNoteInvalidRecipient:
        "We couldn't send to that email address — please check it for typos and try again.",
      breakdownTitle: 'Where the build budget goes',
      breakdownLocked: 'The breakdown is revealed in your full report.',
      finishLevelLabel: 'Selected finish level',
      tierDescriptors: {
        standard:
          'Quality finishes throughout — finishes are never compromised, with fewer premium upgrades. Standard (non-oak) cabinetry, 9 ft basement ceilings.',
        premium:
          'A clear step up in every room: hardwood and tile, stone counters, upgraded cabinetry, and designer fixtures.',
        luxury:
          'Oak kitchen cabinetry, 10 ft ceilings, outdoor fireplace, feature walls, and a fully finished basement — including the gym.',
      },
      tierChoicesNote:
        'Premium upgrades — like basement in-floor heating, marble countertops, or upgraded windows — are explicit choices you make in your finish tier, never costs hidden in the number.',
      coverageTitle: 'What your estimate covers',
      includedLine:
        'Built the way a real Calgary builder budgets — across 60+ line items covering structure, envelope, interior finishes, mechanical systems, and standard allowances. Everything is in, except the exclusions below.',
      costMovementNote:
        'Final costs can move with inflation, your material choices, and project-specific conditions — the planning range above reflects how far they can swing.',
      exclusionsTitle: "What's not in this estimate",
      exclusions: [
        'Landscaping — it varies too much from lot to lot to price, so budget it separately with your builder',
      ],
      tierTitle: 'What if you change the finish tier?',
      tierToggleHint: 'Pick a finish level — every figure on this page updates to match.',
      tierLockedNote: 'Your full report adds the cost breakdown and next steps.',
      adjustTitle: 'Adjust the size',
      decreaseLabel: 'Decrease square footage',
      increaseLabel: 'Increase square footage',
      adjustHint: 'Tap to change the living area — every figure on this page updates automatically.',
      adjustUnit: 'sq ft',
      adjustCta: 'Re-run estimate',
      adjustLockedNote: 'Get your full report to adjust the size.',
      /** RENO: the size stepper becomes an affected-area stepper on reno reports. */
      adjustTitleReno: 'Adjust the affected area',
      adjustHintReno:
        'Tap to change the renovation area — every figure on this page updates automatically.',
      adjustLockedNoteReno: 'Get your full report to adjust the affected area.',
      renoScopeLabel: 'Renovation scope',
      updatingLabel: 'Updating your estimate…',
      updatedLabel: 'Updated {date}',
      printPreparedLabel: 'Prepared {date}',
      perSqftUnit: 'per sq ft',
      narrativeTitle: 'AI summary',
      narrativeComingSoon:
        'An AI-written summary of your estimate, the key risks, and what to watch for is coming soon.',
      aiSummaryLocked: 'Get your full report to read the AI neighbourhood guide.',
      aiSummaryUnavailable:
        'The AI neighbourhood guide is not available for this report right now — the figures above are the complete estimate.',
      /** Shown when every narrative model failed: the static Calgary guide, honestly labeled. */
      staticGuideTitle: 'Building in Calgary',
      staticGuideNote:
        'Our AI summary is unavailable right now — here’s a general guide.',
      stepsTitle: 'Your next three steps',
      steps: [
        {
          id: 'talk-to-builder',
          title: 'Talk to a builder',
          body: 'Request a callback below and we will walk through the numbers with you — free, with no pressure.',
        },
        {
          id: 'refine-brief',
          title: 'Refine your project brief',
          body: 'Adjust your inputs and every figure updates instantly — no re-run button. Compare the Standard and Luxury tiers, and lock in your must-haves — a clear brief is what turns this estimate into quotes you can actually compare.',
        },
        {
          id: 'save-share',
          title: 'Save and share',
          body: 'Download the PDF, email this report to your partner, or ask us to call you back — your report link stays valid for 7 days.',
        },
      ],
      makeupLabel: 'What makes up the total',
      adjustPanelTitle: 'Adjust your estimate',
      actionsTitle: 'Save and share',
      planningTitle: 'Planning ahead',
      financingTitle: 'Financing this build',
      financingLines: [
        'A new build is usually financed with a construction loan, not a regular mortgage — your lender releases money in draws as each stage of the build is completed.',
        'Lenders typically want to see your plans, your builder contract, and a cost breakdown like this report before they approve anything.',
        'Talk to a lender early — financing terms shape what you can build, so it pays to know your numbers before final drawings.',
      ],
      shareTitle: 'Share with a partner',
      shareHint: 'Email this report to a partner — they receive their own secure link.',
      shareEmailLabel: 'Partner email',
      shareCta: 'Send report',
      shareInvalid: 'Enter a valid email address.',
      shareSending: 'Sending…',
      shareSent: 'Sent — {email} will receive their own secure link.',
      shareError: 'Couldn’t send the report. Check your connection and try again.',
      shareSelfError:
        'That’s the email you used for this report — enter your partner’s email address instead.',
      shareTokenError:
        'This report link is no longer available in this tab. Reopen it from the link in your email, then send again.',
      shareRetry: 'Try again',
      partnerViewNote:
        'This report was shared with you — you’re viewing a read-only copy.',
      callbackTitle: 'Talk to a builder',
      callbackHint:
        'Request a callback and we will walk through the numbers with you — free, with no pressure.',
      callbackNameLabel: 'Your name',
      callbackPhoneLabel: 'Phone number',
      callbackWindowLabel: 'Preferred time',
      callbackWindows: [
        { id: 'morning', label: 'Morning' },
        { id: 'afternoon', label: 'Afternoon' },
        { id: 'evening', label: 'Evening' },
      ],
      callbackCta: 'Request callback',
      callbackSuccess: 'Callback requested — we will call at your preferred time.',
      callbackError: 'We could not request the callback. Please try again in a moment.',
      callbackInvalid: 'Enter your name and a phone number.',
      pdfCta: 'Download PDF',
      pdfGenerating: 'Preparing your PDF…',
      pdfError: 'We could not generate the PDF. Please try again in a moment.',
      pdfNarrativeFallback:
        'A written summary is not available for this report — the figures above are the complete estimate.',
      pdfInputsLine: '{sqft} sq ft · {tier} tier',
      loadingLabel: 'Loading your report…',
      loadError: 'We could not load your report. Please try again in a moment.',
      retryLabel: 'Try again',
      versionLabel: 'Report version',
      // RENO-04: reno-specific report copy (exact copy required by acceptance criteria)
      renoPermitNote: 'Permit and contingency allowances are estimates — confirm with the City of Calgary and your builder.',
      renoDeterministicNote: 'Dollar figures are calculated deterministically from our cost model — not generated by AI.',
      estimateAnotherLabel: 'Estimate another address',
    },
    gate: {
      heading: 'Where should we send your estimate?',
      sub: 'One quick step and your personalized cost report is on its way. No spam — we may reach out about your estimate, and you can opt out anytime.',
      trustLine: 'Built from your City of Calgary property record — no guesswork.',
      nameLabel: 'Full name',
      namePlaceholder: 'Jane Doe',
      nameRequired: 'Please enter your name.',
      emailLabel: 'Email address',
      emailPlaceholder: 'jane@example.com',
      emailRequired: 'Please enter your email address.',
      emailInvalid: 'That email doesn’t look right — please check it and try again.',
      phoneLabel: 'Phone',
      phonePlaceholder: '(403) 555-0123',
      optionalMarker: '(optional)',
      phoneInvalid: 'That phone number doesn’t look right — digits and basic punctuation only.',
      phonePattern: '^[+()\\-.\\s\\d]{7,20}$',
      timelineLabel: 'When are you hoping to build?',
      timelineLabelReno: 'When are you hoping to renovate?',
      timelinePlaceholder: 'Choose one…',
      // Karan 2026-09-27: the timeline question is required — it determines
      // the best leads.
      timelineRequired: 'Please choose when you’re hoping to build.',
      timelineOptions: [
        { id: '0-3mo', label: 'Within 3 months' },
        { id: '3-6mo', label: '3–6 months' },
        { id: '6-12mo', label: '6–12 months' },
        { id: '12+mo', label: '12+ months' },
        { id: 'exploring', label: 'Just exploring' },
      ],
      // DRAFT — pending legal review: final CASL consent wording needs lawyer
      // blessing before launch. Do not present this copy as legally approved.
      // Contact model (Karan 2026-09-27): Feasly and builders associated with
      // us MAY proactively contact the lead about their estimate; the lead can
      // opt out anytime. The checkbox is REQUIRED to submit the gate.
      consentLabel:
        'I agree to the Terms and Privacy Policy, and that Feasly and builders associated with us may contact me about my estimate. I can opt out anytime.',
      consentRequired: 'Please agree to the contact consent above to continue.',
      privacyNote:
        'We use your details to deliver your estimate and may share them with builders associated with us — never sold. See our',
      privacyLinkLabel: 'Privacy Policy',
      submitLabel: 'Show my report →',
      submittingLabel: 'Sending…',
      submitError: 'We couldn’t save your details. Please check your connection and try again.',
      retryLabel: 'Try again',
      backLabel: '← Back to preview',
      backLabelComparison: '← Back to comparison',
    },
    analyzing: {
      heading: 'Building your estimate…',
      sub: 'Give us a moment — we’re pulling your property details and running the numbers for real. Nothing here is made up.',
      stageValidate: 'Checking your inputs',
      stageFetch: 'Fetching your City property record',
      stageEstimate: 'Running your cost estimate',
      statusPending: 'Waiting',
      statusActive: 'In progress',
      statusDone: 'Done',
      statusError: 'Failed',
      errorHeading: 'We couldn’t run your estimate',
      errorBody: 'Something went wrong on our end. Nothing was lost — please try again.',
      retryLabel: 'Try again',
      backLabel: '← Back to your project details',
    },
    // Renovation is out of launch scope (Karan 2026-09-27): reno users land
    // on a designed coming-soon page instead of the analyzing pipeline.
    waitlist: {
      emailLabel: 'Email',
      emailPlaceholder: 'you@example.com',
      submitLabel: 'Notify me',
      sendingLabel: 'Saving…',
      invalidEmail: 'Please enter a valid email address.',
      error: 'We couldn’t save that just now. Please try again in a moment.',
      privacyNote: 'We’ll only use this to email you when it’s ready. Nothing else.',
      // DRAFT — pending legal review (owner decision 2026-11-15, same status
      // as the lead-gate consent). REQUIRED to submit. Must byte-match
      // docs/legal/approved-copy.md "CASL waitlist consent wording"
      // (tools/check-casl-copy.mjs). Bump WAITLIST_CONSENT_VERSION in
      // apps/api/src/lib/legal-copy.ts when it changes.
      consentLabel:
        'I agree to the Privacy Policy and that Feasly may email me when this launches. I can unsubscribe anytime.',
      privacyLinkLabel: 'Privacy Policy',
      consentRequired: 'Please tick the box to agree, so we can email you.',
      successByTopic: {
        renovation: 'You’re on the list. We’ll email you when renovation estimates are ready.',
        toronto: 'You’re on the list. We’ll email you when Feasly covers Toronto.',
        vancouver: 'You’re on the list. We’ll email you when Feasly covers Vancouver.',
      },
      renovation: {
        heading: 'Renovation estimates are coming soon',
        body: 'We’re building them the same way as our new-build estimates: real City data and one fixed formula. Leave your email and we’ll tell you when they’re ready.',
      },
      city: {
        heading: 'Want Feasly in your city?',
        body: 'Toronto and Vancouver are next. Leave your email and we’ll tell you when your city is covered.',
        topicLabel: 'Your city',
        cities: [
          { id: 'toronto', name: 'Toronto', match: 'toronto' },
          { id: 'vancouver', name: 'Vancouver', match: 'vancouver' },
        ],
      },
    },
    renoComingSoon: {
      heading: 'Renovations are coming soon',
      body: 'Renovation estimates aren’t quite ready yet — we’re building them the same honest way as our new-build estimates, with real City data and the same fixed formula. In the meantime, you can run a new-build estimate right now.',
      newBuildCta: 'Start a new-build estimate',
      backLabel: '← Back to your project details',
    },
    seo: {
      landingTitle: 'Feasly — What will it really cost to build your home in Calgary?',
      landing:
        'Free range-based estimate of what it costs to build a home in Calgary — new builds today, renovations coming soon. Land, build, and total investment by Standard, Premium, or Luxury finish tier, from real City property data.',
      scopeTitle: 'Feasly — Configure your build scope',
      scope: 'Set your build size and finish tier for a Calgary new home build estimate — step 2 of 3.',
      renoScopeTitle: 'Feasly — Describe your renovation',
      renoScope: 'Describe your Calgary renovation — type, area, and finishes — step 2 of 3.',
      previewTitle: 'Feasly — Your estimate preview',
      preview:
        'Your blurred build-cost and total preview for your Calgary new home build estimate — get the full report.',
      reportTitle: 'Feasly — Your build estimate report',
      report: 'Your range-based Calgary new home build estimate: cost breakdown, tier scenarios, and next steps.',
      sampleReportTitle: 'Feasly — Sample build estimate report (SAMPLE)',
      sampleReport:
        'SAMPLE — a fictional, watermarked example of a Feasly build estimate report. Illustrative figures only, not a real estimate.',
      gateTitle: 'Feasly — Get your free estimate report',
      gate: 'Enter your details to see your personalized Calgary new home build estimate report.',
      analyzingTitle: 'Feasly — Building your estimate',
      analyzing: 'We’re preparing your personalized Calgary new home build cost estimate right now.',
      renoComingSoonTitle: 'Feasly — Renovations are coming soon',
      renoComingSoon:
        'Renovation estimates are on the way — start a free new home build estimate in the meantime.',
      compareTitle: 'Feasly — Compare neighbourhoods',
      compare: 'Compare side-by-side build costs for 2–3 Calgary communities.',
      privacyTitle: 'Feasly — Privacy Policy',
      privacy:
        'How Feasly collects, uses, and protects your information when you generate a build estimate.',
      termsTitle: 'Feasly — Terms of Use',
      terms: 'The terms that apply when you use Feasly to generate a build estimate.',
      howItWorksTitle: 'Feasly — How it works',
      howItWorks:
        'How Feasly builds your Calgary new home build estimate in 4 steps: address, scope, preview, report. Same fixed formula, real City data.',
      faqTitle: 'Feasly — Frequently asked questions',
      faq: 'How much does it cost to build a house in Calgary? Are renovation estimates available? Answers about Calgary build costs, finish tiers, data, and privacy.',
      pillarGuideTitle: 'Feasly — How much does it cost to build a house in Calgary?',
      pillarGuide:
        'Planning ranges for building a house in Calgary: cost per square foot by Standard, Premium, and Luxury finish tier, what is included, infill vs greenfield, and financing basics — from real City property data.',
      zoningGuideTitle: 'Calgary Zoning Explained: What R-C1, R-C2, R-CG & Other Zones Mean | Feasly',
      zoningGuide:
        'What Calgary zoning designations mean: R-C1, R-C1s, R-C2, R-CG, R-G, H-GO, multi-residential, commercial, industrial, and Direct Control — and which zones allow a single-family build.',
      developersTitle: 'Feasly — API docs for developers',
      developers:
        'Build on the Feasly API: address-aware property data, deterministic build estimates, and lead capture. Quickstart, auth, scopes, rate limits, errors, sandbox, and the live OpenAPI spec.',
      communitiesTitle: 'Feasly — Calgary community guides',
      communities:
        'Browse Calgary community guides, from inner-city infill areas to newer suburbs: average assessed values and dwelling mix, plus estimated new-build cost ranges by finish tier where single-family homes get built.',
      notFoundTitle: 'Feasly — Page not found',
      notFound: "The page you're looking for moved or never existed.",
      errorTitle: 'Feasly — Something went wrong',
      error: 'Your estimate is safe — try again in a moment.',
      unsubscribeTitle: 'Feasly — Email preferences',
      unsubscribe: 'Manage your Feasly email preferences — unsubscribe from follow-ups and product updates.',
      privacyDataTitle: 'Feasly — Your data',
      privacyData: 'Download a copy of the data Feasly holds about you, or ask us to delete it.',
      privacyConfirmTitle: 'Feasly — Confirm data deletion',
      privacyConfirm: 'Confirm your request to delete the data Feasly holds about you.',
      magicLinkTitle: 'Feasly — Opening your estimate',
      magicLink: 'Opening your secure Feasly estimate link — verifying and opening your Calgary build estimate.',
      myReportTitle: 'Feasly — Find your report',
      myReport: 'Request a fresh link to your Feasly build estimate by email.',
      // Admin console (admin/07): per-section titles for client-side nav.
      // All noindexed via the seo-routes table — never in search results.
      adminHomeTitle: 'Admin — Feasly',
      adminHome: 'Feasly admin console.',
      adminLeadsTitle: 'Leads — Feasly Admin',
      adminLeads: 'Feasly admin leads explorer.',
      adminBuildersTitle: 'Builders — Feasly Admin',
      adminBuilders: 'Feasly admin builders management.',
      adminUsersTitle: 'Users — Feasly Admin',
      adminUsers: 'Feasly admin user management.',
      adminDisputesTitle: 'Disputes — Feasly Admin',
      adminDisputes: 'Feasly admin billing dispute console.',
      adminCalibrationTitle: 'Calibration — Feasly Admin',
      adminCalibration: 'Cost engine calibration console.',
      adminBillingTitle: 'Billing — Feasly Admin',
      adminBilling: 'Feasly admin billing health dashboard.',
      adminInvoicesTitle: 'Invoices — Feasly Admin',
      adminInvoices: 'Feasly admin commission invoice list.',
      adminInvoiceDetailTitle: 'Invoice detail — Feasly Admin',
      adminInvoiceDetail: 'Feasly admin commission invoice detail.',
      adminSheetsTitle: 'Sheets sync — Feasly Admin',
      adminSheets: 'Feasly admin Google Sheets sync status.',
      adminEstimatesTitle: 'Estimate lookup — Feasly Admin',
      adminEstimates: 'Read-only admin estimate lookup.',
      adminApiKeysTitle: 'API keys — Feasly Admin',
      adminApiKeys: 'Feasly admin API key management.',
      adminFunnelsTitle: 'Funnels — Feasly Admin',
      adminFunnels: 'Feasly admin funnel analytics.',
      adminWebhooksTitle: 'Webhooks — Feasly Admin',
      adminWebhooks: 'Feasly admin Stripe webhook health.',
      adminQuarantineTitle: 'Quarantine — Feasly Admin',
      adminQuarantine: 'Feasly admin quarantine queue for honeypot-flagged leads.',
      adminLoginTitle: 'Admin sign in — Feasly',
      adminLogin: 'Feasly admin sign in.',
      adminCallbackTitle: 'Completing sign in — Feasly',
      adminCallback: 'Completing your Feasly admin sign in.',
    },
    marketing: {
      howItWorks: {
        eyebrow: 'How it works',
        title: 'From address to estimate in about 2 minutes',
        sub: 'Just your address and a few project details. We may reach out about your estimate — opt out anytime.',
        steps: [
          {
            n: '01',
            title: 'Enter your Calgary address',
            body: 'We pull your City of Calgary property record — lot size, zoning, and assessed land value. Only Calgary addresses are supported right now.',
          },
          {
            n: '02',
            title: 'Configure your scope',
            body: 'Tell us about the project: living area, finish tier, garage, and basement. Rough figures are fine — you can adjust them later. Renovation estimates are coming soon.',
          },
          {
            n: '03',
            title: 'Preview your estimate',
            body: 'See a blurred preview of your build-cost range before you share anything. No email required to look.',
          },
          {
            n: '04',
            title: 'Get your full report',
            body: 'Enter your email and your full report opens immediately: total investment, cost breakdown, and next steps. We also email you a link to reopen it anytime — valid for 7 days.',
          },
        ],
        mathNoteTitle: 'Real math, not guesses',
        mathNoteBody:
          'Every dollar figure in your estimate is produced by a fixed formula from current cost data and your City property record. Our AI writes the narrative summary only — it never invents prices. Figures are planning ranges, not quotes or appraisals: your final cost depends on your builder, finishes, and market conditions.',
        ctaNewBuild: 'Start a new-build estimate →',
        ctaReno: 'Renovation estimates — coming soon',
        zoningCardTitle: 'Why we ask about your address',
        zoningCardBody:
          'Your address tells us your lot\u2019s City land use designation \u2014 the zoning code that decides what can be built there. We quote single-family homes in every residential zone where a single-detached house is allowed (our zoning guide lists them), so if your lot is zoned for apartments, shops, or industry, we\u2019ll say so plainly instead of inventing a number.',
        zoningCardCta: 'Learn about Calgary zoning →',
      },
      faq: {
        eyebrow: 'FAQ',
        title: 'Frequently asked questions',
        sub: 'The short answers about Feasly, your data, and your estimate.',
        items: [
          {
            q: 'How much does it cost to build a house in Calgary?',
            a: 'It depends on three things: the land value in your community, the size of the home, and the finish tier you choose. That is why Feasly answers with a planning range, not a single number — run a free estimate with your address and project details to see the range for your lot, covering land, build, and total investment.',
          },
          {
            q: 'What is the difference between Standard, Premium, and Luxury finishes?',
            a: 'The tiers describe the level of materials and detailing in your build — from practical, durable Standard finishes, to upgraded Premium selections, to high-end Luxury specifications. Your estimate shows all three side by side so you can see what each level means for your budget.',
          },
          {
            q: 'Can Feasly estimate my renovation?',
            a: 'Not yet — renovation estimates are coming soon, built the same honest way as our new-build estimates, with real City data and the same fixed formula. New-build estimates are live today and take about two minutes.',
          },
          {
            q: 'Is Feasly a home builder? Will you recommend one?',
            a: 'No — Feasly is an independent estimator, not a builder. If you ask to be contacted, leads from Feasly’s own site go to our builder partner(s), listed on How it works. A partner pays Feasly a referral commission only if you sign a contract with them. You’re never obliged to hire anyone, and you can opt out anytime.',
          },
          {
            q: 'How long does it take to build a home in Calgary?',
            a: 'A custom infill home in Calgary typically takes 12–16 months from design through permits to completion. Your report shows the typical range for each phase, from design and permits to construction. Your builder, permits, and site conditions set the actual schedule. Buying a pre-sale or move-in-ready home follows a different timeline.',
          },
          {
            q: 'Is Feasly free?',
            a: 'There is no charge to generate an estimate or get your full report.',
          },
          {
            q: 'What data do you use for my estimate?',
            a: 'Your City of Calgary property assessment record (lot size, zoning, assessed land value) plus the project details you enter. Cost figures come from current construction cost data run through a fixed formula — no AI-generated prices.',
          },
          {
            q: 'How accurate are the estimates?',
            a: 'Estimates are planning ranges, not quotes or appraisals. They give you a realistic budget window before you talk to builders. Your final cost depends on your builder, finish choices, and market conditions at build time.',
          },
          {
            q: 'Who sees my information?',
            a: 'Feasly and builders associated with us may see your information so we can contact you about your estimate. Your email is also how we send you a link to reopen your report; we never sell your information, and you can opt out anytime. See our Privacy Policy for the full details.',
          },
          {
            q: 'How do builder introductions work?',
            a: 'Feasly is an independent estimator. We don’t build homes. If you ask to be contacted, leads from Feasly’s own site go to our builder partner(s), listed on How it works. A partner pays Feasly a referral commission only if you sign a contract with them. It never changes your estimate, and you’re never obliged to hire anyone. You can opt out anytime.',
          },
          {
            q: 'Do you support addresses outside Calgary?',
            a: 'Not yet — Feasly only supports Calgary addresses right now, because our cost data and property records are Calgary-specific. Enter a non-Calgary address and we’ll tell you plainly instead of guessing.',
          },
          {
            q: 'How does the magic link work?',
            a: 'Your report opens the moment you enter your email — no password to remember. We also email you a magic link so you can reopen it on another device anytime. The link expires after 7 days; if it lapses, just run the estimate again and we’ll send a fresh one.',
          },
        ],
      },
      pillarGuide: {
        eyebrow: 'Calgary build-cost guide',
        title: 'How much does it cost to build a house in Calgary?',
        lede: 'For a typical 2,400 sq ft new build, most Calgary projects budget roughly $1.2M–$2.1M all-in including land. The build itself usually lands between $195 and $541 per square foot depending on finish tier — and your lot’s assessed land value swings the total more than anything else.',
        tiersTitle: 'Cost per square foot by finish tier',
        tiersIntro:
          'Build cost before land, for a typical 2,400 sq ft home, from our current cost model. These are planning ranges to budget with — your builder’s quote is what counts.',
        tiers: [
          {
            name: 'Standard',
            range: '$195–$293 per sq ft',
            blurb: 'Practical, durable finishes — the sensible default for a family home.',
          },
          {
            name: 'Premium',
            range: '$262–$391 per sq ft',
            blurb: 'Upgraded selections throughout — nicer kitchens, baths, and detailing.',
          },
          {
            name: 'Luxury',
            range: '$360–$541 per sq ft',
            blurb: 'High-end specifications — custom millwork, stone, and top-tier mechanical.',
          },
        ],
        exampleTitle: 'What that looks like for a 2,400 sq ft home',
        exampleBody:
          'At 2,400 square feet — a common size for a Calgary infill — the build itself budgets roughly $468,000–$703,000 at Standard tier, $629,000–$938,000 at Premium, and $864,000–$1,298,000 at Luxury. Land sits on top: the City-assessed value varies a lot by neighbourhood — each community guide shows its own average.',
        includedTitle: 'What’s included in the estimate',
        includedBody:
          'Feasly budgets the way a real Calgary builder does — across 60+ line items covering structure, envelope, interior finishes, mechanical systems, and standard allowances. Demolition, soil and servicing, permits and fees, financing costs, and GST are part of the range.',
        excludedTitle: 'What’s not included',
        excludedBody:
          'Only landscaping — it varies too much from lot to lot to price honestly, so budget it separately with your builder.',
        infillTitle: 'Infill vs greenfield: why the lot changes the math',
        infillBody:
          'On an infill lot — a teardown in an established neighbourhood — expect demolition costs and sometimes servicing upgrades, in exchange for a known neighbourhood and no new-suburb premiums. On a greenfield lot in a new community, the developer sets the land price and servicing is brand new. Either way, build cost per square foot follows the same tiers above; it is the land line that moves.',
        financingTitle: 'How people usually pay for a build',
        financingBody:
          'Most custom builds use a construction loan: the lender releases money in draws as work is completed, and you typically pay interest only until the home is done and the loan converts to a regular mortgage. Talk to a mortgage broker early — they will tell you what you qualify for before you fall in love with a floor plan. Feasly does not offer financing or recommend lenders.',
        faqTitle: 'Common questions',
        faqs: [
          {
            q: 'How much does it cost to build a house in Calgary?',
            a: 'For a typical 2,400 sq ft home, budget roughly $1.2M–$2.1M all-in including land. The build itself runs $195–$541 per square foot depending on finish tier, and land is the City-assessed value, which varies widely by community. Run a free estimate with your address for the range on your lot.',
          },
          {
            q: 'What drives the cost up or down the most?',
            a: 'Three things: your lot’s land value, the size of the home, and the finish tier. Land value swings the total more than anything else in Calgary — the same house can budget hundreds of thousands apart in different neighbourhoods.',
          },
          {
            q: 'Is land included in the estimate?',
            a: 'Yes — Feasly adds your lot’s City-assessed land value to the build cost, so the total is the full investment. Browse our community cost guides to see how land values differ across Calgary.',
          },
          {
            q: 'Are these numbers quotes?',
            a: 'No — they are planning ranges to budget with before you talk to builders. Your final cost depends on your builder, your finish choices, and market conditions at build time. Bring your Feasly range to builders and ask them to explain any big difference.',
          },
          {
            q: 'How long does it take to build a house in Calgary?',
            a: 'A custom infill home in Calgary typically takes 12–16 months from design through permits to completion. Your report shows the typical range for each phase, from design and permits to construction. Your builder, permits, and site conditions set the actual schedule. Buying a pre-sale or move-in-ready home follows a different timeline.',
          },
          {
            q: 'Which Calgary communities cost the least to build in?',
            a: 'Land value drives the all-in number, so communities with lower assessed land values budget lower overall. Our community cost guides show average assessed values and build ranges for Calgary neighbourhoods — start there to compare.',
          },
        ],
        mathNoteTitle: 'Real math, not guesses',
        mathNoteBody:
          'Every dollar figure on this page comes from the same fixed cost model behind our estimator: current construction cost data plus City of Calgary property records. Figures are planning ranges, not quotes. Your final cost depends on your builder, finishes, and market conditions.',
        ctaEstimate: 'Get my free estimate →',
        ctaCommunities: 'Browse community cost guides',
      },
      /**
       * Zoning explainer (SEO guides): long-form "Calgary zoning explained"
       * guide at `/guides/calgary-zoning-explained`. Zone facts follow the
       * City of Calgary Land Use Bylaw 1P2007 — no invented designations.
       */
      zoningGuide: {
        eyebrow: 'Calgary zoning guide',
        title: "Calgary zoning explained: what your lot's designation means",
        lede: 'Every parcel in Calgary carries a zoning designation \u2014 a short code like R-C1 or M-C2 set under the City\u2019s Land Use Bylaw. That code decides what can be built on the lot: a single-detached home, a duplex, rowhouses, an apartment building, or shops. If you are thinking about building, zoning is the first thing to check \u2014 before budgets, before floor plans.',
        introTitle: 'What zoning is',
        introBody:
          'Zoning \u2014 the City calls it "land use designation" \u2014 is the rulebook tied to a piece of land. It controls which uses are allowed (a home, a duplex, an apartment building, a shop), plus height, lot coverage, and setbacks. Two lots on the same street can carry different designations and allow very different projects, which is why Feasly checks your lot\u2019s designation before quoting.',
        tableTitle: 'Can I build a single-family home here?',
        tableIntro:
          'The zones you will actually encounter on Calgary land, and whether a single-family build is allowed on each. Definitions follow the City of Calgary Land Use Bylaw 1P2007.',
        tableHeaders: {
          zone: 'Zone',
          name: 'Full name',
          allows: 'What it allows',
          build: 'Single-family build?',
        },
        zones: [
          {
            code: 'R-C1',
            name: 'Residential – Contextual Single Detached',
            allows: 'Single-detached homes, plus secondary and backyard suites',
            build: 'Yes',
          },
          {
            code: 'R-C1s',
            name: 'R-C1 with secondary suite',
            allows: 'As R-C1, with a secondary suite allowed',
            build: 'Yes',
          },
          {
            code: 'R-C1L / R-C1Ls',
            name: 'Residential – Contextual Large Parcel One Dwelling',
            allows: 'Single-detached homes on large lots (the "s" version also allows a secondary suite)',
            build: 'Yes',
          },
          {
            code: 'R-C1N',
            name: 'Residential – Contextual Narrow Parcel One Dwelling',
            allows: 'Single-detached homes on narrow lots, plus suites',
            build: 'Yes',
          },
          {
            code: 'R-C2',
            name: 'Residential – Contextual Duplex',
            allows: 'Single-detached, semi-detached and duplex homes, plus suites',
            build: 'Yes',
          },
          {
            code: 'R-CG',
            name: 'Residential – Contextual Grade-Oriented Infill',
            allows: 'Single-detached, semi-detached, rowhouses and suites (up to about 4 units)',
            build: 'Yes — discretionary use, needs City approval',
          },
          {
            code: 'R-1 / R-1s / R-1N',
            name: 'Residential – One Dwelling (newer communities)',
            allows: 'Single-detached homes; R-1s adds a secondary suite, R-1N is for narrow lots',
            build: 'Yes',
          },
          {
            code: 'R-2',
            name: 'Residential – One / Two Dwelling',
            allows: 'Single-detached, semi-detached and duplex homes',
            build: 'Yes',
          },
          {
            code: 'R-2M',
            name: 'Residential – Low Density Multiple Dwelling',
            allows: 'Single-detached, semi-detached, duplex and row homes',
            build: 'Yes — discretionary use, needs City approval',
          },
          {
            code: 'R-G',
            name: 'Residential – Low Density Mixed Housing',
            allows: 'Single, semi-detached, duplex and row homes, plus suites (common in new communities)',
            build: 'Yes',
          },
          {
            code: 'R-Gm',
            name: 'Residential – Low Density Mixed Housing (attached housing)',
            allows: 'Semi-detached, duplex and row homes, plus suites; single-detached only with City approval',
            build: 'Yes — discretionary use, needs City approval',
          },
          {
            code: 'H-GO',
            name: 'Housing – Grade Oriented',
            allows: 'All ground-oriented housing forms (every unit has direct access to grade)',
            build: 'Yes',
          },
          {
            code: 'M-C1 / M-C2',
            name: 'Multi-Residential – Contextual',
            allows: 'Low and medium-profile apartment buildings',
            build: 'No',
          },
          {
            code: 'M-H1 / M-H2 / M-H3',
            name: 'Multi-Residential – High Density',
            allows: 'Apartment towers',
            build: 'No',
          },
          {
            code: 'M-X1 / M-X2',
            name: 'Multi-Residential mixed-use',
            allows: 'Apartment/condo buildings mixed with commercial uses',
            build: 'No',
          },
          {
            code: 'DC',
            name: 'Direct Control',
            allows: 'Site-specific rules approved by Council for that exact parcel',
            build: 'Maybe — check the individual DC bylaw',
          },
          {
            code: 'C-*',
            name: 'Commercial (C-COR, C-COM, C-N1…)',
            allows: 'Shops, offices, and commercial corridors',
            build: 'No',
          },
          {
            code: 'I-*',
            name: 'Industrial (I-G, I-B, I-E…)',
            allows: 'Warehouses, manufacturing, and business industrial',
            build: 'No',
          },
          {
            code: 'S-*',
            name: 'Special Purpose',
            allows: 'Schools, parks, utilities, and future development land',
            build: 'Generally no',
          },
        ],
        recentTitle: 'Zoning has changed recently in Calgary',
        recentBody:
          'A note on timing: in 2024 the City made R-CG the default designation for most residential lots; in 2026 Council voted to repeal that change, and most properties reverted to their previous designation (often R-C1 or R-C2) effective August 2026. Guides and articles written in 2024–2025 may describe rules that no longer apply to a given lot — always check the current designation for the specific parcel (see below).',
        lookupTitle: "How to find your property's zoning",
        lookupBody:
          'Use the City of Calgary\u2019s Development Map: search for "Development Map" on calgary.ca, type in the address, and it shows the parcel\u2019s current land use district. It takes about a minute, and it is the same source builders and the City itself use.',
        faqTitle: 'Common questions',
        faqs: [
          {
            q: 'What does R-C1 mean?',
            a: 'R-C1 (Residential – Contextual Single Detached) is Calgary\u2019s classic single-family zone: one detached home per lot, plus a secondary or backyard suite. Most established neighbourhoods\u2019 single-family streets are R-C1.',
          },
          {
            q: 'Can I build a duplex on an R-C1 lot?',
            a: 'No — a duplex is not a permitted use in R-C1. You would need the lot rezoned (for example to R-C2), which is a City application with a public hearing and no guaranteed outcome. If a duplex is the plan, start with an R-C2 lot instead.',
          },
          {
            q: 'My lot is R-CG — can I still build a single-family home?',
            a: 'Usually, but it needs City approval. In R-CG (Residential – Contextual Grade-Oriented Infill) a single-detached home is a discretionary use (Land Use Bylaw 1P2007, s. 527(2)(r)), so the City has to approve it. Semi-detached homes, rowhouses and suites are also possible. Feasly still gives R-CG lots an estimate and notes the approval step.',
          },
          {
            q: 'What is Direct Control (DC) zoning?',
            a: 'Direct Control means the lot has its own site-specific rules approved by Council instead of a standard district. What is allowed depends on that lot\u2019s individual DC bylaw — there is no shortcut, so check the bylaw for the specific parcel.',
          },
          {
            q: 'Can zoning change?',
            a: 'Yes. A property owner can apply to redesignate (rezone) a parcel, and Council decides at a public hearing. City-wide changes happen too — Calgary rezoned most residential lots to R-CG in 2024 and reversed that in 2026. Because designations move, always verify the current one with the City before making plans.',
          },
          {
            q: 'Why does Feasly only quote single-family homes?',
            a: 'Our estimator prices single-family new builds. When you enter an address, we check the City land use designation: lots in a zone where a single-detached house is allowed (the zones marked \u201cYes\u201d in the zoning table on this page) get a quote, and anything else gets a plain "not supported" message. We would rather turn down a quote than invent a number for a building type we do not price.',
            anchor: 'why-single-family-only',
          },
          {
            q: "How do I find my property's zoning?",
            a: 'Use the City of Calgary\u2019s Development Map — search for it on calgary.ca, enter the address, and it shows the parcel\u2019s land use district.',
          },
        ],
        sourceTitle: 'Sources',
        sourceBody:
          'Zone definitions follow the City of Calgary Land Use Bylaw 1P2007.',
        sourceLinkLabel: 'Read the Land Use Bylaw on calgary.ca',
        sourceUrl:
          'https://www.calgary.ca/planning/land-use/online-land-use-bylaw.html?part=7&div=4',
        verifyNote:
          'Designations can change through rezoning. Always verify the current designation for your parcel with the City before making plans.',
        ctaEstimate: 'Check what your lot can build →',
        ctaCostGuide: 'Read the Calgary build-cost guide',
      },
      communities: {
        landingTitle: 'Browse community guides',
        landingBody:
          'Guides for Calgary communities, from inner-city infill areas to newer suburbs — assessed values, dwelling mix, and cost ranges by finish tier where single-family homes get built.',
        intro:
          'Every community, one page: average assessed values and dwelling mix from City of Calgary assessment data — plus estimated new-build cost ranges by finish tier in communities where single-family homes get built. Pick a community to see its guide.',
        groups: {
          established: {
            heading: 'Established and inner-city communities',
            body: 'Older neighbourhoods where most Calgary infill homes get built. Averages on cost guides use single-detached and semi-detached homes only.',
          },
          newer: {
            heading: 'Newer communities',
            body: 'Communities built from the 1980s on.',
          },
        },
      },
    },
    buildTimeline: {
      title: 'Typical build timeline',
      intro: 'How long a custom infill home typically takes, from first drawings to moving in.',
      totalTemplate: 'Typical total: {min}–{max} months',
      rangeTemplates: { weeks: '{min}–{max} weeks', months: '{min}–{max} months' },
      phasesLabel: 'Build phases',
      overlapNote:
        'Some phases overlap. Your builder can confirm a schedule once plans are drawn and permits are filed.',
      presaleNote: 'Buying a pre-sale or move-in-ready home follows a different timeline.',
    },
    // #878 (owner decision 2026-11-15, option (a)): partner-model disclosure.
    // Status: draft-pending-lawyer — mirrored in docs/legal/approved-copy.md
    // ("Builder-partner disclosure"); the FAQ answer "How do builder
    // introductions work?" carries the same wording. Neutral-matching claims
    // ("no paid placement", "project fit", …) are banned by
    // tools/check-banned-phrases.mjs. Embedded estimators don't render this
    // explainer: on a builder's own site the lead goes to that builder.
    builderMatching: {
      summary: 'What does "builders associated with us" mean?',
      paragraphs: [
        'Feasly is an independent estimator. We don’t build homes.',
        'If you ask to be contacted, leads from Feasly’s own site go to our builder partner(s), listed on How it works. A partner pays Feasly a referral commission only if you sign a contract with them.',
        'It never changes your estimate, and you’re never obliged to hire anyone. You can opt out anytime.',
      ],
    },
    // #918: partner disclosure at own-site lead capture + How it works.
    // Same draft-pending-lawyer status as builderMatching above; names come
    // from GET /api/v1/partners, never from copy.
    partners: {
      disclosureLead: 'Leads from Feasly’s site go to our builder partner(s):',
      disclosureFallbackLead: 'Leads from Feasly’s site go to our builder partner(s), listed on',
      howItWorksLinkLabel: 'How it works',
      nameSeparator: ', ',
      newTabLabel: '(opens in a new tab)',
      sectionTitle: 'Our builder partners',
      sectionIntro:
        'If you ask to be contacted, leads from Feasly’s own site go to these builder companies. A partner pays Feasly a referral commission only if you sign a contract with them. It never changes your estimate, and you’re never obliged to hire anyone.',
      sectionUnavailable: 'The partner list isn’t available right now. Please try again later.',
    },
    consent: {
      title: 'A quick word on analytics.',
      body: 'We measure which pages people visit so we can improve Feasly. First-party only — no cookies, no trackers, no selling data. Accept or decline; the site works the same either way.',
      accept: 'Accept analytics',
      decline: 'Decline',
    },
    // legal/01 AC3: staging banner copy while legal.reviewPending is true.
    // Story-pinned wording — do not paraphrase.
    legal: {
      reviewBannerHeading: 'Draft — pending legal review',
      reviewBannerBody:
        'This legal copy is a draft awaiting review by our lawyer. It is shown for evaluation only and is not the final policy.',
    },
    communities: {
      illustrativeBanner:
        'Illustrative ranges — our cost data is being calibrated. Final figures coming soon.',
      titleTemplate: 'Feasly — Cost to build a home in {name}, Calgary',
      descriptionTemplate:
        'Planning cost ranges for building a home in {name}, Calgary — average City-assessed value {avgAssessed}, Standard/Premium/Luxury build ranges, and FAQs.',
      statLabel: 'Average City-assessed value (not market value)',
      statNote:
        'The average City of Calgary assessment for single-detached and semi-detached homes in this community — condos, apartments and non-residential properties are left out. Assessments are for tax purposes and can differ from actual sale prices.',
      statCountLabel: 'Detached and semi-detached homes assessed',
      profileStatNote:
        'The average City of Calgary assessment for homes in this community — houses, condos and apartments alike; non-residential properties are left out. Assessments are for tax purposes and can differ from actual sale prices.',
      basisNote:
        'City-assessed basis: land is the community average City-assessed value (a fixed fact, not a range). Build ranges assume 2,400 sqft of above-grade living area.',
      tierSectionTitle: 'What it costs to build in {name}',
      tierSectionSub: 'Planning ranges for a typical new build, by finish tier.',
      totalLabel: 'Total investment',
      landSplitLabel: 'Land',
      buildSplitLabel: 'Build',
      splitBarLabelTemplate:
        'Cost split: land {land} is about {landPct}% of the total; build {build} makes up about {buildPct}%.',
      faqTitle: 'Common questions',
      faqItems: [
        {
          q: 'What does the cost range cover?',
          a: 'The range covers construction of a typical new home (2,400 sqft above grade) plus the community average City-assessed land value. It is a planning budget, not a builder quote — get your address-specific estimate for figures tuned to your lot.',
        },
        {
          q: 'What is the difference between assessed value and sale price?',
          a: 'The City-assessed value is set by the City of Calgary for property tax purposes. Sale price is what a buyer actually pays. The two often differ — assessments can lag behind real sales. We use assessed values because they are public, consistent, and available for every property.',
        },
        {
          q: 'Why do you show ranges instead of a fixed price?',
          a: 'Build costs depend on choices you have not made yet: your builder, finish tier, and market conditions at build time. A range is the honest answer at this stage. Your address-specific estimate narrows it using your actual lot and project details.',
        },
        {
          q: 'What is not included in these figures?',
          a: 'Only landscaping — it varies too much from lot to lot to price, so budget it separately with your builder. Everything else (demolition, soil and servicing, permits and fees, financing, GST) is part of the estimate range.',
        },
        {
          q: 'What is the next step?',
          a: 'Run your address-specific estimate — it takes about 2 minutes and uses your actual City property record. You will get a full report with a three-bucket cost breakdown and your next steps.',
        },
      ],
      ctaTitle: 'Building in {name}?',
      ctaBody:
        'Get figures for your actual lot — assessed land value, lot size, and zoning pulled from your City property record.',
      ctaLabel: 'Get your address-specific estimate →',
      // NOTE: the property-profile page copy used to live here. It moved to
      // `app/features/communities/community-profile-copy.defaults.ts` and is
      // lazy-loaded with the profile variant so the initial bundle doesn't
      // carry it (Lighthouse script-size budget).
      zoningGuideLink: 'What do zoning codes like R-C1 mean? Read our Calgary zoning guide →',
      // Coverage-redirect property card (guide variant, QA 2026-10-04): the
      // estimator's coverage gate redirects rejected properties here — the
      // card explains why and shows the property's assessed value versus
      // the community average, like the profile variant's hero.
      coverageLede:
        "We can't build-cost this address yet — here's the City-assessed value, compared with the {name} average.",
      propertyValueLabel: "This address's assessed value",
      communityAverageLabel: '{name} average',
      comparePropertyTag: 'This address',
      compareBarCaption: 'Bars drawn proportional to the larger value.',
      compareBarLabelTemplate:
        'Bar comparison: this address assessed at {propertyValue} versus the {name} average of {avgAssessed}',
      coverageHonestNote:
        'City of Calgary {year} assessment roll. Assessed value is for tax purposes — not market value.',
    },
    /**
     * Builder portal wiring. Only infrastructure config lives in the root
     * defaults now: the Entra tenant wiring is needed at startup (the
     * Entra auth service is root-provided). All user-facing builder-portal
     * copy moved to DEFAULT_BUILDER_COPY — lazy-loaded with the builder
     * portal via BUILDER_COPY so it stays out of the initial bundle.
     */
    builder: {
      /**
       * Builder Entra (auth/05). Placeholders — the backend team provides
       * the real builder-tenant values in the deployed app-config.json.
       * A separate app registration from the admin portal's: builder
       * sign-in must never mint an admin session.
       */
      entra: {
        tenantSubdomain: 'ENTRA_BUILDER_TENANT_SUBDOMAIN',
        tenantId: 'ENTRA_BUILDER_TENANT_ID',
        clientId: 'ENTRA_BUILDER_CLIENT_ID',
        userFlow: 'ENTRA_BUILDER_USER_FLOW',
        authorizeUrlTemplate:
          'https://{tenantSubdomain}.ciamlogin.com/{tenantId}/oauth2/v2.0/authorize',
      },
    },
    admin: {
      shell: {
        brand: 'Feasly Admin',
        homeLabel: 'Feasly Admin home',
        navLabel: 'Admin',
        groups: { pipeline: 'Pipeline', partners: 'Partners', money: 'Money', system: 'System' },
        nav: {
          leads: 'Leads',
          estimates: 'Estimates',
          builders: 'Builders',
          users: 'Users & access',
          apiKeys: 'API keys',
          billing: 'Billing overview',
          invoices: 'Invoices',
          disputes: 'Disputes',
          calibration: 'Calibration',
          sheets: 'Sheets sync',
          funnels: 'Funnels',
          webhooks: 'Webhooks',
          quarantine: 'Quarantine',
        },
        badgeSuffix: 'open',
        openMenu: 'Open menu',
        closeMenu: 'Close menu',
        collapseSidebar: 'Collapse sidebar',
        expandSidebar: 'Expand sidebar',
        breadcrumbLabel: 'Breadcrumb',
        searchLabel: 'Search',
        searchShortcut: '⌘K',
        searchKeyShortcuts: 'Meta+K Control+K /',
        palette: {
          title: 'Search the admin console',
          placeholder: 'Search leads, invoices, builders, users…',
          hint: 'Type a name, email, address, invoice number or builder slug.',
          loading: 'Searching…',
          noResults: 'No matches.',
          error: 'Search failed.',
          retry: 'Try again',
          close: 'Close search',
          escKey: 'Esc',
          resultsLabel: 'Search results',
          navHint: '↑↓ to move · Enter to open · Esc to close',
          kinds: { lead: 'Leads', invoice: 'Invoices', builder: 'Builders', user: 'Users' },
        },
        environmentLabel: 'Environment',
        userMenuLabel: 'Account',
        signOut: 'Sign out',
      },
      quarantine: {
        title: 'Quarantine',
        description:
          'Honeypot-flagged submissions land here instead of being dropped. Approve to return a lead to the pipeline, or discard it (kept for audit, hidden from every list).',
        searchLabel: 'Search quarantine',
        searchPlaceholder: 'Name, email or address',
        clearFilters: 'Clear search',
        countOne: '{count} quarantined lead',
        countMany: '{count} quarantined leads',
        tableLabel: 'Quarantined leads',
        columns: { lead: 'Lead', address: 'Address', source: 'Source', tenant: 'Tenant', created: 'Flagged' },
        emptyHeading: 'Quarantine is clear',
        emptyMessage: 'Nothing is waiting for review.',
        noResultsHeading: 'No quarantined leads match',
        noResultsMessage: 'Try a different search, or clear it.',
        errorHeading: 'Couldn’t load the quarantine queue',
        loadError: 'Could not load the quarantine queue. Please try again.',
        retry: 'Try again',
        loading: 'Loading quarantined leads',
        actionsHeader: 'Actions',
        loadMore: 'Load more',
        loadingMore: 'Loading…',
        selectAll: 'Select all quarantined leads on this page',
        selectRow: 'Select',
        selectedCount: 'selected',
        approve: 'Approve',
        approving: 'Approving…',
        discard: 'Discard…',
        discarding: 'Discarding…',
        approveSelected: 'Approve selected…',
        discardSelected: 'Discard selected…',
        cancel: 'Cancel',
        approveConfirmTitleMany: 'Approve {count} leads?',
        approveConfirmBody: 'They leave quarantine and return to the pipeline on the Leads page.',
        discardConfirmTitle: 'Discard {name}?',
        discardConfirmTitleMany: 'Discard {count} leads?',
        discardConfirmBody:
          'Discarded leads are kept for audit but hidden from every list and count. This can’t be undone here.',
        approvedOne: 'Lead approved — back in the pipeline.',
        approvedMany: '{count} leads approved — back in the pipeline.',
        discardedOne: 'Lead discarded.',
        discardedMany: '{count} leads discarded.',
        failedOne: 'Could not update the lead. Please try again.',
        failedMany: '{failed} of {total} leads could not be updated and are still selected. Please try again.',
        dismiss: 'Dismiss',
      },
      leads: {
        title: 'Leads',
        description: 'Every lead across builders. Open a row to work it.',
        sandboxToggle: 'Include sandbox',
        exportCsv: 'Export CSV',
        exporting: 'Exporting…',
        dismiss: 'Dismiss',
        totalsLabel: 'Pipeline totals — select a status to filter',
        viewsLabel: 'Saved views',
        views: {
          all: 'All',
          new: 'New',
          unassigned: 'Unassigned',
          quotingStale: 'Quoting > {days} days',
        },
        viewHints: {
          all: 'Every lead that matches your filters.',
          new: 'Leads nobody has contacted yet.',
          unassigned: 'Leads not assigned to a builder.',
          quotingStale: 'Leads in Quoting that came in more than {days} days ago.',
        },
        searchLabel: 'Search leads',
        searchPlaceholder: 'Name, email or address',
        statusFilter: 'Status',
        anyStatus: 'Any status',
        assignedFilter: 'Builder',
        anyAssignment: 'Any builder',
        unassigned: 'Unassigned',
        clearFilters: 'Clear filters',
        countOne: '{count} lead',
        countMany: '{count} leads',
        sandboxExcluded: '(sandbox excluded)',
        tableLabel: 'Leads',
        columns: {
          lead: 'Lead',
          address: 'Address',
          status: 'Status',
          tenant: 'Tenant',
          source: 'Source',
          score: 'Score',
          timeline: 'Timeline',
          consent: 'Contact consent',
          created: 'Created',
        },
        consentIn: 'In',
        consentOut: 'Out',
        sandboxBadge: 'Sandbox',
        emptyHeading: 'No leads yet',
        emptyMessage: 'Leads appear here as soon as homeowners request an estimate.',
        noResultsHeading: 'No leads match',
        noResultsMessage: 'Try a different search, another view, or clear the filters.',
        errorHeading: 'Couldn’t load leads',
        retry: 'Try again',
        loading: 'Loading leads',
        actionsHeader: 'Actions',
        loadMore: 'Load more',
        loadingMore: 'Loading…',
        drawer: {
          loading: 'Loading lead…',
          refreshing: 'Refreshing…',
          retry: 'Try again',
          close: 'Close lead',
          cancel: 'Cancel',
          save: 'Save',
          saving: 'Saving…',
          saved: 'Lead saved',
          readOnlyHint: 'You have read-only access to this lead.',
          sections: {
            pipeline: 'Pipeline',
            contact: 'Contact',
            property: 'Property & estimate',
            invoices: 'Invoices',
            notes: 'Notes',
            comments: 'Comments',
            activity: 'Activity',
            record: 'Record',
          },
          statusLabel: 'Status',
          builderLabel: 'Assigned builder',
          unassigned: 'Unassigned',
          labels: {
            email: 'Email',
            phone: 'Phone',
            source: 'Source',
            tenant: 'Tenant',
            magicLink: 'Report link',
            contactConsent: 'Contact consent',
            marketingConsent: 'Marketing consent',
            address: 'Address',
            projectType: 'Project type',
            livingArea: 'Living area',
            finishTier: 'Finish tier',
            totalRange: 'Total range',
            buildRange: 'Build range',
            land: 'Land (City-assessed)',
            estimated: 'Estimated',
            leadScore: 'Lead score',
            consented: 'Consented',
            sheetsSynced: 'Sheets synced',
            snapshots: 'Report snapshots',
            unsubscribed: 'Unsubscribed',
            nudgeSent: 'Nudge sent',
          },
          sqftValue: '{sqft} sq ft',
          yes: 'Yes',
          no: 'No',
          magicLink: {
            sent: 'Sent — the customer can open their report from the email.',
            used: 'Used — the customer already opened their report.',
            expired: 'Expired — the customer can request a fresh link.',
            none: 'Not sent yet.',
          },
          openEstimate: 'Open estimate',
          noEstimate: 'No estimate linked to this lead.',
          invoicesHint: 'Commission invoices are raised once a won lead’s contract is recorded.',
          openInvoices: 'Open invoices',
          noNotes: 'No notes yet.',
          addNoteLabel: 'Add a note',
          addNotePlaceholder: 'Add a note…',
          addNote: 'Add note',
          addingNote: 'Adding…',
          notesHint: 'Notes are append-only — they can’t be edited or deleted.',
          commentsHint: 'Choose per comment whether the builder sees it.',
          noActivity: 'No status changes yet.',
          honeypotBadge: 'Honeypot-flagged',
        },
      },
      entities: {
        technicalIds: 'Technical IDs',
        copyId: 'Copy ID',
        idCopied: 'ID copied',
        viewLead: 'View lead',
        viewInvoice: 'View invoice',
        rawPayload: 'Raw payload',
      },
      apiKeys: {
        title: 'API keys',
        subtitle: 'Keys for the public API and MCP server. A new key is shown once, when you issue or rotate it.',
        issueButton: 'Issue key',
        tableLabel: 'API keys',
        colName: 'Name',
        colBuilder: 'Builder',
        colPrefix: 'Prefix',
        colScopes: 'Scopes',
        colLastUsed: 'Last used',
        colStatus: 'Status',
        never: 'Never',
        noBuilder: 'No builder',
        sandboxChip: 'Sandbox',
        openKey: 'Open',
        empty: 'No API keys yet',
        emptyMessage: 'Issue a key to give a builder or partner access to the API.',
        loadError: 'Couldn’t load API keys',
        loadErrorMessage: 'Check the admin key configuration and try again.',
        retry: 'Try again',
        tabsLabel: 'Key details',
        tabOverview: 'Overview',
        tabUsage: 'Usage',
        builderLabel: 'Builder',
        prefixLabel: 'Key',
        modeLabel: 'Mode',
        modeLive: 'Live',
        modeSandbox: 'Sandbox (feasly_test_, never billed)',
        createdLabel: 'Created',
        lastUsedLabel: 'Last used',
        revokedAtLabel: 'Revoked',
        accessHeading: 'Access',
        accessHint: 'Changes apply on the key’s next request.',
        revokedNote: 'This key is revoked. It no longer works and can’t be edited.',
        scopesLabel: 'Scopes',
        scopesError: 'Pick at least one scope.',
        rateLimitLabel: 'Rate limit (per minute)',
        rateLimitHint: 'Requests per minute before the API answers 429.',
        rateLimitError: 'Enter a whole number from 1 to {max}.',
        saveButton: 'Save',
        savedToast: 'Key updated.',
        saveError: 'Couldn’t save the key. Try again.',
        closeButton: 'Close',
        dangerHeading: 'Rotate or revoke',
        rotateHint: 'Issues a new key and stops the old one.',
        revokeHint: 'Stops the key for good.',
        rotateButton: 'Rotate',
        revokeButton: 'Revoke',
        rotateConfirmTitle: 'Rotate {name}?',
        rotateConfirm: 'The old key stops working immediately. You’ll see the new key once.',
        revokeConfirmTitle: 'Revoke {name}?',
        revokeConfirm: 'The key stops working immediately. This cannot be undone.',
        cancelButton: 'Cancel',
        revokedToast: 'Key revoked.',
        actionError: 'That didn’t work. Try again.',
        usageChartLabel: 'Requests per day',
        usageTotal: '{count} requests over {days} days',
        usageShowTable: 'Show daily table by endpoint',
        usageLoading: 'Loading usage…',
        usageEmpty: 'No usage recorded yet.',
        usageDateHeader: 'Date',
        usageEndpointHeader: 'Endpoint',
        usageRequestsHeader: 'Requests',
        usageEstimatesHeader: 'Estimates',
        issueTitle: 'Issue an API key',
        nameLabel: 'Name',
        namePlaceholder: 'e.g. Elite Craft production',
        nameError: 'Give the key a name.',
        builderPlaceholder: 'Search builders',
        builderHint: 'Optional. Leave blank for a key not tied to a builder.',
        builderEmpty: 'No builders match',
        sandboxLabel: 'Sandbox key',
        sandboxHint: 'Prefixed feasly_test_. Writes are sandboxed and never billed.',
        createButton: 'Issue key',
        issueError: 'Couldn’t issue the key. Try again.',
        secretTitle: 'Copy your new API key',
        plaintextWarning: 'This is the only time the full key is shown. Store it somewhere safe now.',
        secretLabel: 'API key',
        copyButton: 'Copy key',
        copiedButton: 'Copied',
        copyFailed: 'Couldn’t copy. Select the key and copy it by hand.',
        ackLabel: 'I’ve stored this key somewhere safe',
        doneButton: 'Done',
      },
      funnels: {
        title: 'Funnel dashboard',
        subtitle: 'Landing → scope → details → preview → gate → report. Numbers only — no personal data on this page.',
        fromLabel: 'From',
        toLabel: 'To',
        tenantLabel: 'Traffic',
        tenantAll: 'All traffic',
        tenantDirect: 'Feasly direct',
        tenantKey: 'One builder…',
        tenantKeyLabel: 'Builder tenant key',
        tenantKeyPlaceholder: 'e.g. elite-craft',
        apply: 'Apply',
        reset: 'Reset',
        loading: 'Loading funnel…',
        empty: 'No visits in this range yet. Widen the dates or check the traffic filter.',
        loadError: 'Couldn’t load the funnel. Check your admin session and try again.',
        invalidRange: 'The start date must be on or before the end date.',
        entryStep: 'Entry step',
        conversionPrefix: 'Converted from previous step:',
        noConversion: '—',
        presetsLabel: 'Date range',
        presets: [
          { label: '7 days', days: 7 },
          { label: '30 days', days: 30 },
          { label: '90 days', days: 90 },
        ],
        presetAll: 'All time',
        overallConversion: 'Overall conversion',
        overallConversionSub: '{from} → {to}',
        dropOff: '{count} dropped off',
        stepsLabel: 'Funnel steps',
      },
      auth: {
        loginExpired: 'Your admin session expired. Sign in again.',
        entraSignInLabel: 'Sign in →',
        entraSignInIntro:
          'Sign in with your Feasly admin account to continue.',
        entraIncomplete: "Sign-in didn't complete — try again.",
        entraStateMismatch: "Sign-in didn't complete — try again.",
        entraTransient: 'Something went wrong. Please try again.',
        entraNotConfigured: 'Sign-in is not set up yet. Contact support.',
      },
    },
    unsubscribe: {
      loadingLabel: 'Checking your link…',
      preferencesHeading: 'Email & contact preferences',
      preferencesBody:
        'Choose what Feasly can contact you about. Your saved estimates stay available through your magic link.',
      emailToggleLabel: 'Estimate update emails',
      emailToggleBody: 'Follow-ups and reminders about your Feasly estimates.',
      contactToggleLabel: 'Calls and messages',
      contactToggleBody:
        'Calls and texts from Feasly and builders associated with us about your estimate.',
      unsubscribeAllCta: 'Unsubscribe from everything',
      saveCta: 'Save preferences',
      savingLabel: 'Saving…',
      doneHeading: 'Preferences saved.',
      doneEmailsOff:
        'You won’t receive estimate follow-ups or product updates anymore.',
      doneEmailsOn: 'You’ll keep receiving estimate updates.',
      doneCallsOff:
        'We won’t call or text you — and we won’t ask builders to either.',
      doneCallsOn:
        'Feasly and associated builders may still contact you by call or text.',
      doneMagicLinkNote:
        'Emails you request — like your estimate magic link — still send.',
      resubscribePrompt: 'Changed your mind?',
      resubscribeBody:
        'Just reply to any Feasly email and we’ll re-subscribe you — no forms, no fuss.',
      expiredHeading: 'This link has expired.',
      expiredBody: 'Preference links expire after 30 days to protect your inbox.',
      expiredCta: 'Reply to any Feasly email to request a fresh link, or start a new estimate below.',
      invalidHeading: 'This link isn’t valid.',
      invalidBody: 'This preferences link doesn’t look right — it may have been copied incompletely.',
      errorHeading: 'Something went wrong.',
      errorBody: 'We couldn’t check your link. Please check your connection and try again.',
      retryLabel: 'Try again',
      homeCta: 'Back to home',
    },
    // #706 privacy self-service. Copy status: draft-pending-lawyer.
    privacyData: {
      entryLinkLabel: 'Download or delete my data',
      heading: 'Your data',
      intro:
        'Download a copy of everything Feasly holds about you, or ask us to delete it. You need the link from your estimate email.',
      draftNotice: 'This wording is a draft pending legal review.',
      loadingLabel: 'Working…',
      downloadHeading: 'Download my data',
      downloadBody:
        'A file with your leads, estimates, report links, callback requests and consent history.',
      downloadCta: 'Download my data',
      downloadWorking: 'Preparing your file…',
      downloadDone: 'Your file has downloaded.',
      downloadFileName: 'feasly-my-data.json',
      deleteHeading: 'Delete my data',
      deleteBody:
        'We delete your lead records and revoke your report links. Your saved estimate links stop working.',
      deleteCta: 'Delete my data',
      deleteWorking: 'Starting your request…',
      pendingHeading: 'Confirm your deletion request',
      pendingBody:
        'Nothing has been deleted yet. Read what happens below, then confirm to delete your data.',
      consequencesHeading: 'What happens when you confirm',
      confirmCta: 'Yes, delete my data',
      cancelCta: 'Keep my data',
      noTokenHeading: 'Open your estimate link first',
      noTokenBody:
        'For your security we need the link from your estimate email. Enter your email and we’ll send a fresh link if we have your details. Open it, then choose “Download or delete my data” at the bottom of your report.',
      emailLabel: 'Email address',
      emailInvalid: 'Enter a valid email address.',
      sendLinkCta: 'Email me a link',
      sendLinkWorking: 'Sending…',
      linkSentHeading: 'Check your inbox',
      linkSentBody:
        'If we have details for that email, a fresh link is on its way. It can take a few minutes.',
      pendingEmailBody:
        'Nothing has been deleted yet. We’ve emailed you a link — open it to confirm the deletion.',
      // #806: confirmationEmailSent=false — a duplicate inside the resend
      // cooldown, a spent send budget, or a failed send (the API doesn't say which).
      pendingEmailNotSentBody:
        'Nothing has been deleted yet. We couldn’t send a new confirmation email just now. If you asked in the last few minutes, check your inbox for our earlier email. Otherwise, send it again.',
      resendEmailCta: 'Send the email again',
      resendEmailWorking: 'Sending…',
      confirmPromptHeading: 'Delete your data?',
      confirmPromptBody:
        'This deletes your lead records and revokes your report links. It can’t be undone.',
      confirmWorking: 'Deleting your data…',
      confirmDoneHeading: 'Your data has been deleted.',
      confirmDoneBody:
        'Your lead records are deleted and your report links no longer work. We also cleared the saved estimate on this device.',
      confirmAlreadyHeading: 'Already deleted',
      confirmAlreadyBody: 'This deletion request was already completed. There is nothing more to do.',
      confirmExpiredHeading: 'This confirmation link has expired.',
      confirmExpiredBody:
        'Request a fresh link from the “Your data” page and start the deletion again.',
      confirmBlockedHeading: 'We couldn’t delete everything yet.',
      confirmBlockedBody:
        'Some records have to be kept for now. Your request is saved — reply to any Feasly email and we’ll explain what is kept and why.',
      confirmInvalidHeading: 'This confirmation link isn’t valid.',
      confirmInvalidBody: 'It may have been copied incompletely. Start again from the “Your data” page.',
      expiredHeading: 'Your link has expired.',
      expiredBody: 'Enter your email below and we’ll send a fresh link if we have your details.',
      rateLimitedHeading: 'Too many requests.',
      rateLimitedBody: 'Please wait a minute and try again.',
      errorHeading: 'Something went wrong.',
      errorBody: 'We couldn’t complete that. Please check your connection and try again.',
      retryLabel: 'Try again',
      myDataCta: 'Go to “Your data”',
      homeCta: 'Back to home',
    },
    magicLink: {
      loadingLabel: 'Opening your estimate…',
      invalidHeading: 'This link isn’t valid.',
      invalidBody:
        'This estimate link doesn’t look right — it may have been copied incompletely. Request a fresh one below.',
      expiredHeading: 'This link has expired.',
      expiredBody: 'Estimate links expire after 7 days to protect your information.',
      errorHeading: 'Something went wrong.',
      errorBody: 'We couldn’t check your link. Please check your connection and try again.',
      retryLabel: 'Try again',
      homeCta: 'Back to home',
      resendPrompt: 'Need a fresh link?',
      resendEmailLabel: 'Email address',
      resendEmailPlaceholder: 'you@example.com',
      resendEmailError: 'Enter a valid email address.',
      resendCta: 'Email me a fresh link',
      resendingLabel: 'Sending…',
      resendDoneHeading: 'Your fresh link is on its way.',
      resendDoneBody: 'Check your inbox — your new estimate link is on its way. It expires in 7 days.',
      resendErrorBody: 'We couldn’t send a fresh link. Check your connection and try again.',
    },
    myReport: {
      heading: 'Find your report',
      body: 'Enter the email you used for your estimate and we’ll send you a link to your report.',
      emailLabel: 'Email address',
      emailPlaceholder: 'you@example.com',
      emailError: 'Enter a valid email address.',
      cta: 'Email me my report link',
      sendingLabel: 'Sending…',
      sentHeading: 'Check your inbox',
      sentBody:
        'If that email has an estimate with us, a link to your report is on its way. It can take a few minutes, so check your spam folder too.',
      rateLimitedBody: 'Too many requests just now. Wait a minute, then try again.',
      errorBody: 'We couldn’t send your link. Check your connection and try again.',
      homeCta: 'Back to home',
    },
    returning: {
      findReportPrompt: 'Already have an estimate?',
      findReportLink: 'Find my report',
      resumeLabel: 'Continue your estimate for {address}',
      resumeDismissLabel: 'Dismiss',
      copyLinkCta: 'Copy link',
      copyLinkDone: 'Link copied',
      copyLinkError: 'We couldn’t copy the link. Try again.',
      nativeShareCta: 'Share',
      shareLinkHint:
        'The link opens a preview for this address. Whoever opens it enters their own email to see the full figures.',
      shareTitle: 'Feasly build estimate',
      shareText: 'Build cost estimate for {address}',
    },
  },
};
