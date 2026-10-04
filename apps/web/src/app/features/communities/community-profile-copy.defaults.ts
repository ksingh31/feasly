import type { RawCommunityProfileCopy } from '@feasly/contracts';

/**
 * Default copy for the community property-profile page variant
 * (condo/apartment-dominated communities). Lazy-loaded with the profile
 * variant via dynamic import in CommunityPageComponent — never imported
 * from an eager module — so the initial bundle doesn't carry it
 * (Lighthouse script-size budget).
 *
 * Placeholders {name}, {year}, {avgAssessed}, {multiPct}, {semiPct},
 * {singlePct} are filled by `resolveProfileCopy`; never render raw.
 * `statLabel`/`statNote` are intentionally absent: the route component
 * merges the build-guide's assessed-value wording over this copy (same
 * figure, same wording, one source of truth).
 *
 * Deploy-time overrides are not wired for this copy (unlike BUILDER_COPY):
 * the served `/assets/config/app-config.json` never carried profile keys.
 */
export const DEFAULT_COMMUNITY_PROFILE_COPY: RawCommunityProfileCopy = {
  kicker: 'Community property profile',
  titleTemplate: '{name} Calgary Property Values & Assessed Values | Feasly',
  descriptionTemplate:
    'Property values in {name}, Calgary — average City-assessed value {avgAssessed} and how Calgary assessments work, from City of Calgary data.',
  lede: "most homes in {name} are apartments, condos, and townhouses rather than single-family houses. Here's what the City of Calgary says this property is worth.",
  ledeLead: "We don't quote this property type yet",
  propertyValueLabel: "This property's assessed value",
  communityAverageLabel: '{name} average',
  comparePropertyTag: 'This property',
  compareBarCaption: 'Bars drawn proportional to the larger value.',
  compareBarLabelTemplate:
    'Bar comparison: this property assessed at {propertyValue} versus the {name} average of {avgAssessed}',
  honestNote:
    'City of Calgary {year} assessment roll. Assessed value is for tax purposes — not market value.',
  averageHeroLabel: '{name} average assessed value',
  homesAssessedLabel: 'Homes assessed',
  homesAssessedSub: '{year} assessment roll',
  mostCommonTypeLabel: 'Most common home type',
  assessmentYearLabel: 'Assessment year',
  mixTitle: 'What people live in here',
  mixBody:
    'Dwelling mix from City assessment records. This is why {name} gets a property profile instead of a build-cost guide — with this mix, a per-house construction estimate would be misleading.',
  mixBarLabelTemplate:
    'Dwelling mix: {multiPct}% apartments, condos and townhouses, {semiPct}% semi-detached and duplexes, {singlePct}% single-detached.',
  typeLabels: {
    singleDetached: 'Single-detached',
    semiDuplex: 'Semi-detached / duplex',
    multiFamily: 'Apartments, condos & townhouses',
  } as const,
  noBuildTitle: "Why you won't see build prices on this page",
  noBuildBody:
    'Our build-cost guides assume a single-family home on its own lot. In {name}, that scenario is the exception — publishing a "cost to build in {name}" figure would be misleading. If you are evaluating a multi-family or mixed-use project, that is a conversation, not a calculator.',
  noBuildGuideLink: 'See the Calgary build-cost guide →',
  explainerTitle: 'How Calgary assessments work',
  explainerItems: [
    {
      title: 'Assessed value is not market value.',
      body: "It's the City's estimate for property-tax purposes, based on sales in the area — usually trailing the live market by months.",
    },
    {
      title: 'Condos are assessed as units.',
      body: "Your unit's value plus a share of common property — land value isn't broken out the way it is for a house lot.",
    },
    {
      title: 'Useful for comparing neighbourhoods,',
      body: 'not for pricing a specific purchase. Always pair it with recent comparable sales.',
    },
  ],
  faqTitle: 'Common questions',
  faqItems: [
    {
      q: 'What is a City-assessed value?',
      a: 'The value the City of Calgary assigns to a property for property-tax purposes. It is based on market activity in the area and is reassessed every year — it is a tax basis, not an appraisal or a listing price.',
    },
    {
      q: 'Why is there no build-cost guide for {name}?',
      a: 'Our build-cost guides assume a single-family home on its own lot. Most homes in {name} are apartments, condos, or townhouses, so a per-house build figure would be misleading. This page shows assessed property values instead.',
    },
    {
      q: 'Are assessed values the same as sale prices?',
      a: 'No. Assessed values are set for tax purposes and can trail actual sale prices by months. They are useful for comparing neighbourhoods because they are public, consistent, and cover every property — but price a specific purchase off recent comparable sales.',
    },
    {
      q: 'How current is this data?',
      a: 'Figures on this page come from the City of Calgary {year} property assessment roll, the most recent published roll.',
    },
  ],
  nearbyTitle: 'Nearby communities',
  ctaTitle: 'Building a home elsewhere in Calgary?',
  ctaBody:
    'Get a free build-cost estimate for a single-family home — standard, premium, and luxury finish tiers.',
  ctaEstimateLabel: 'Get a free estimate →',
  ctaGuideLabel: 'Calgary build-cost guide',
  finePrint:
    'Figures from the City of Calgary {year} property assessment roll. Averages cover all residential assessment records in {name}; dwelling mix counts residential dwelling records only (excludes condo common elements, parking, and storage).',
};
