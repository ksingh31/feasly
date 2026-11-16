import type { ZoningGuideCopy } from './app-config';

/**
 * Compiled zoning guide copy defaults (#980), split out of DEFAULT_APP_CONFIG so
 * they ship in the lazy chunk that renders them instead of the initial
 * bundle (Lighthouse script budget). Same rules as app-config.defaults.ts:
 * every value mirrors `public/assets/config/app-config.json`, whose
 * overrides are merged over these defaults by mergeLazyCopy().
 * Allowlisted in tools/hardcode-allowlist.txt.
 */
export const DEFAULT_ZONING_GUIDE_COPY: ZoningGuideCopy = {
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
};
