import type { MatchFilterKey } from './match-selection';

/** One chip: a match priority (nice/must) or a build filter (on/off). */
export type FindCommunityChip =
  | { readonly kind: 'priority'; readonly key: string; readonly label: string }
  | { readonly kind: 'filter'; readonly key: MatchFilterKey; readonly label: string };

/**
 * `/find-a-community` copy (#779). Lazy: ships with the page chunk, not
 * DEFAULT_APP_CONFIG (Lighthouse script budget). Deploy overrides at
 * `copy.findCommunity` in app-config.json merge over these defaults.
 *
 * Priority keys must be keys the match API knows (amenity categories from
 * the API config, 'tree-cover', 'designated-schools').
 */
export interface FindCommunityCopy {
  eyebrow: string;
  title: string;
  /** Answer-first passage (SEO standard §2.1). */
  answer: string;
  prioritiesTitle: string;
  /** How the chips work (tap once / twice / three times). */
  prioritiesHint: string;
  stateNice: string;
  stateMust: string;
  stateOn: string;
  groups: { id: string; title: string; chips: FindCommunityChip[] }[];
  shareNote: string;
  resultsTitle: string;
  emptyPrompt: string;
  loading: string;
  error: string;
  retry: string;
  noResults: string;
  /** Placeholders: {count}, {total}. */
  resultsCount: string;
  /** Placeholders: {match}. */
  matchLabel: string;
  missedMustBadge: string;
  reasonsLabel: string;
  missesLabel: string;
  /** Placeholders: {listed}. */
  lotsListed: string;
  /** Placeholders: {matching}, {listed}. */
  lotsMatching: string;
  noLots: string;
  buildRangeLabel: string;
  noBuildRange: string;
  /** Placeholders: {sqft}. */
  buildBasis: string;
  draftCostData: string;
  /** Placeholders: {name}. */
  viewCommunity: string;
  /** Placeholders: {name}. */
  compareLabel: string;
  compareTrayTitle: string;
  /** Placeholders: {count}, {max}. */
  compareTrayCount: string;
  /** Placeholders: {max}. */
  compareLimit: string;
  compareShow: string;
  compareHide: string;
  compareClear: string;
  /** Placeholders: {name}. */
  compareRemove: string;
  compareTableCaption: string;
  compareRowMatch: string;
  compareRowMustHaves: string;
  compareRowLots: string;
  compareRowBuild: string;
  compareRowReasons: string;
  yes: string;
  no: string;
  notesTitle: string;
  notes: string[];
  /** Placeholders: {date}. */
  refreshed: string;
  relatedTitle: string;
  guidesLink: string;
  compareLink: string;
  estimateLink: string;
}

export const DEFAULT_FIND_COMMUNITY_COPY: FindCommunityCopy = {
  eyebrow: 'Find a community',
  title: 'Find a Calgary infill community that fits',
  answer:
    'Pick what matters to you, like typically designated schools, parks, pathways or lots for sale, and Feasly ranks Calgary’s established infill communities against it. Each one shows why it fits, what it misses, how many lots are listed now and a typical new-build range, all from City of Calgary open data refreshed monthly.',
  prioritiesTitle: 'What matters to you?',
  prioritiesHint:
    'Tap a priority once for Nice to have, twice for Must have, and a third time to turn it off.',
  stateNice: 'Nice to have',
  stateMust: 'Must have',
  stateOn: 'On',
  groups: [
    {
      id: 'schools',
      title: 'Schools',
      chips: [{ kind: 'priority', key: 'designated-schools', label: 'Typically designated schools' }],
    },
    {
      id: 'getting-around',
      title: 'Getting around',
      chips: [{ kind: 'priority', key: 'pathways', label: 'Pathways' }],
    },
    {
      id: 'lifestyle',
      title: 'Lifestyle',
      chips: [
        { kind: 'priority', key: 'parks', label: 'Parks' },
        { kind: 'priority', key: 'playgrounds', label: 'Playgrounds' },
        { kind: 'priority', key: 'off-leash', label: 'Off-leash areas' },
        { kind: 'priority', key: 'rec-centres', label: 'Recreation centres' },
        { kind: 'priority', key: 'pools', label: 'Pools' },
        { kind: 'priority', key: 'libraries', label: 'Libraries' },
        { kind: 'priority', key: 'tree-cover', label: 'Tree cover' },
      ],
    },
    {
      id: 'your-build',
      title: 'Your build',
      chips: [
        { kind: 'filter', key: 'lots-listed-now', label: 'Lots listed now' },
        { kind: 'filter', key: 'wide-lot', label: 'Wider lots ({ft} ft+)' },
      ],
    },
  ],
  shareNote: 'Your choices are saved in this page’s link, so you can share it or come back to it.',
  resultsTitle: 'Communities ranked for you',
  emptyPrompt: 'Pick at least one priority above to see communities ranked.',
  loading: 'Ranking communities…',
  error: 'We couldn’t rank communities just now.',
  retry: 'Try again',
  noResults: 'No communities fit these build filters. Try turning one off.',
  resultsCount: 'Showing {count} of {total} communities',
  matchLabel: '{match}% match',
  missedMustBadge: 'Misses a must-have',
  reasonsLabel: 'Why it fits',
  missesLabel: 'What it misses',
  lotsListed: '{listed} lots listed now',
  lotsMatching: '{matching} of {listed} listed lots fit your build',
  noLots: 'No lots listed right now',
  buildRangeLabel: 'Typical new build',
  noBuildRange: 'No lot-size data yet',
  buildBasis: 'Typical new-build ranges are for a {sqft} sq ft home on the community’s average lot, from the Feasly cost engine.',
  draftCostData: 'Cost data is still being calibrated, so treat ranges as illustrative.',
  viewCommunity: 'View {name}',
  compareLabel: 'Compare {name}',
  compareTrayTitle: 'Compare',
  compareTrayCount: '{count} of {max} selected',
  compareLimit: 'You can compare up to {max} communities. Remove one to add another.',
  compareShow: 'Compare side by side',
  compareHide: 'Hide comparison',
  compareClear: 'Clear',
  compareRemove: 'Remove {name}',
  compareTableCaption: 'Selected communities side by side',
  compareRowMatch: 'Match',
  compareRowMustHaves: 'Meets your must-haves',
  compareRowLots: 'Lots listed now',
  compareRowBuild: 'Typical new build',
  compareRowReasons: 'Why it fits',
  yes: 'Yes',
  no: 'No',
  notesTitle: 'How the ranking works',
  notes: [
    'Schools are typically designated for the community. Confirm with the board before you rely on one.',
    'Distances are straight-line, not travel times.',
    'Lot frontage is estimated from lot area. Confirm the lot with the City before you buy.',
    'Only established infill communities are ranked.',
  ],
  refreshed: 'Community data refreshed {date}.',
  relatedTitle: 'Keep exploring',
  guidesLink: 'Browse community guides',
  compareLink: 'Compare neighbourhood build costs',
  estimateLink: 'Get an estimate for an address',
};
