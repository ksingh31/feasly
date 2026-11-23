/**
 * Report neighbourhood copy (#785). Lazy: ships with the report chunk, not
 * DEFAULT_APP_CONFIG (Lighthouse script budget). Deploy overrides at
 * `copy.reportNeighbourhood` in app-config.json merge over these defaults.
 *
 * Copy rules: "typically designated", confirm with the board/City; no
 * guarantees, no accuracy claims, no dollar figures.
 */
export interface ReportNeighbourhoodCopy {
  schoolsTitle: string;
  /** Under the schools heading. */
  schoolsNote: string;
  /** Before the board lookup links. */
  lookupLead: string;
  /** Grade band → display label ('K-6' → 'Elementary (K–6)'). */
  gradeBands: Record<string, string>;
  livingTitle: string;
  /** Placeholder: {community}. */
  livingIntro: string;
  /** Placeholders: {name}, {distance}. */
  nearestValue: string;
  treeCoverLabel: string;
  /** Placeholders: {level}, {perHa}. */
  treeCoverValue: string;
  treeLevels: Record<'low' | 'moderate' | 'high', string>;
  /** Distance basis + source + refresh cadence. */
  livingNote: string;
  findCommunityLead: string;
  findCommunityLink: string;
}

export const DEFAULT_REPORT_NEIGHBOURHOOD_COPY: ReportNeighbourhoodCopy = {
  schoolsTitle: 'Schools for this address',
  schoolsNote:
    'These schools are typically designated for this community. Designations can vary by address and change from year to year, so confirm with the board before you decide.',
  lookupLead: 'Confirm your address with the board:',
  gradeBands: {
    'K-6': 'Elementary (K–6)',
    'K-9': 'Kindergarten to grade 9 (K–9)',
    '7-9': 'Junior high (7–9)',
    '10-12': 'High school (10–12)',
  },
  livingTitle: 'Living near this lot',
  livingIntro: 'What is close to the centre of {community}.',
  nearestValue: '{name}, about {distance}',
  treeCoverLabel: 'Public tree cover',
  treeCoverValue: '{level} ({perHa} City trees per hectare)',
  treeLevels: { low: 'Low', moderate: 'Moderate', high: 'High' },
  livingNote:
    'Straight-line distances from the community centre, not travel times. From City of Calgary open data, refreshed monthly.',
  findCommunityLead: 'Weighing other areas? Compare established communities side by side.',
  findCommunityLink: 'Find a community',
};
