import type { CommunityGuideCopy } from './community-guide-copy';

/**
 * Compiled Schools + Living nearby tab copy defaults (#781), kept in the
 * community page's lazy chunk instead of DEFAULT_APP_CONFIG (Lighthouse
 * script budget). Deploy overrides at `copy.communities.guideTabs` are
 * merged over these by injectCommunityGuideCopy(). Allowlisted in
 * tools/hardcode-allowlist.txt.
 *
 * Copy rules: designations are only ever "typically designated"; always
 * "confirm with the board"; no accuracy claims.
 */
export const DEFAULT_COMMUNITY_GUIDE_COPY: CommunityGuideCopy = {
  tabsLabel: 'Community guide sections',
  tabs: { overview: 'Overview', schools: 'Schools', living: 'Living nearby' },
  schools: {
    title: 'Schools in {name}',
    intro:
      'Public, Catholic, charter and private schools in {name}, with published provincial results and enrolment where they exist. School details change — confirm with the school or board.',
    designatedTitle: 'Typically designated schools',
    designatedNotice:
      'These are the schools typically designated for homes in {name}. Designations can vary by address and change year to year — confirm with the board using the address lookups below.',
    designatedEmpty:
      'We have no designations on file for {name} yet — use the board lookups below to find the school for an exact address.',
    lookupLinkTemplate: 'Find the school for your address — {board}',
    gradeBandLabels: { 'K-6': 'K–6', 'K-9': 'K–9', '7-9': 'Grades 7–9', '10-12': 'Grades 10–12' },
    filterLabel: 'Show schools by type',
    filters: [
      { key: 'all', label: 'All' },
      { key: 'public_cbe', label: 'Public (CBE)' },
      { key: 'catholic_ccsd', label: 'Catholic (CCSD)' },
      { key: 'charter', label: 'Charter' },
      { key: 'private', label: 'Private' },
    ],
    typeLabels: {
      public_cbe: 'Public (CBE)',
      catholic_ccsd: 'Catholic (CCSD)',
      francophone: 'Francophone',
      charter: 'Charter',
      private: 'Private',
      alternative: 'Alternative program',
    },
    levels: [
      { key: 'elementary', label: 'Elementary', match: ['elementary', 'k-6', 'k–6', 'primary'] },
      { key: 'junior', label: 'Junior high', match: ['junior', 'middle', '7-9', '7–9'] },
      { key: 'high', label: 'High school', match: ['senior high', 'high school', '10-12', '10–12'] },
      { key: 'all-grades', label: 'All grades', match: ['k-12', 'k–12', '1-12', '1–12'] },
    ],
    otherLevelLabel: 'Other programs',
    programsLabel: 'Programs',
    programLabels: {
      'french-immersion': 'French immersion',
      'international-baccalaureate': 'International Baccalaureate',
      'advanced-placement': 'Advanced Placement',
      arts: 'Arts',
      'spanish-bilingual': 'Spanish bilingual',
      'german-bilingual': 'German bilingual',
      'mandarin-bilingual': 'Mandarin bilingual',
      montessori: 'Montessori',
      waldorf: 'Waldorf',
      stem: 'STEM',
      sports: 'Sports',
      'indigenous-focus': 'Indigenous focus',
      'traditional-learning': 'Traditional learning',
      'dual-credit': 'Dual credit',
      outreach: 'Outreach',
      online: 'Online',
    },
    provincialLabel: 'Provincial results',
    testLabels: { pat6: 'Grade 6 PAT', pat9: 'Grade 9 PAT', diploma: 'Diploma exams' },
    testResultTemplate: '{acceptable} acceptable · {excellence} excellence',
    enrolmentLabel: 'Enrolment',
    enrolmentTemplate: '{enrolment} of {capacity} spaces ({pct}%), {year}',
    fraserLabel: 'Fraser Institute score',
    fraserTemplate: '{score} / 10 ({year})',
    sourceLinkLabel: 'Source',
    notAvailable: 'n/a',
    tuitionNote: 'Charges tuition',
    addToComparison: 'Add to school comparison',
    inComparison: 'Added to comparison',
    comparisonFull: 'Your comparison is full — remove a school to add another.',
    emptyFiltered: 'No schools of this type in {name}.',
    emptyAll: 'We have no schools on file in {name} yet.',
    loading: 'Loading schools…',
    error: "We couldn't load schools right now.",
    retry: 'Try again',
    mapNote: 'A school map is on its way.',
  },
  living: {
    title: 'Living nearby in {name}',
    intro: 'Parks, pathways, groceries, rec centres, transit and more around {name}, from City of Calgary open data.',
    distanceNote: 'Distances are straight-line from the community centre, not travel times.',
    nearestLabel: 'Nearest',
    nearestTemplate: '{place} · {distance}',
    metresPerKm: 1000,
    noneWithin: 'None within {radius}',
    countWithin: '{count} within {radius}',
    treeCoverLabel: 'Public trees',
    treeLevels: { low: 'Fewer public trees', moderate: 'Moderate public trees', high: 'Many public trees' },
    treesPerHaTemplate: '{trees} City-maintained trees per hectare',
    treeNote: 'A count of City-maintained trees, not a measured canopy.',
    refreshedTemplate: 'City data refreshed {date}.',
    loading: 'Loading what is nearby…',
    error: "We couldn't load what is nearby right now.",
    retry: 'Try again',
  },
};
