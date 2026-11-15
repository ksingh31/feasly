/**
 * Community-aggregates contracts for the SEO content pipeline. Build-time only:
 * the generator writes this file, the prerender step reads it. Per-sqft figures
 * and margins must never appear here (deny-list scanned in FE-6).
 */

/** Averages over one subset of a community's assessment records. */
export interface CommunityAverages {
  /** Assessment records the averages are built from. */
  readonly count: number;
  /** Average City-assessed value, integer CAD. */
  readonly avgAssessedValue: number;
  readonly avgLotSqft: number;
}

/**
 * Which records a community's top-level averages come from (#690):
 * `detached-semi` = single-detached + semi-detached homes only (the
 * build-guide basis); `residential` = every residential dwelling record,
 * used only for communities with too few houses (always profile pages).
 */
export type CommunityAveragesBasis = 'detached-semi' | 'residential';

/** Index grouping (#690): established/inner-city vs newer communities. */
export type CommunityGroup = 'established' | 'newer';

export interface CommunityAggregate extends CommunityAverages {
  /** kebab-case, unique. */
  readonly slug: string;
  readonly name: string;
  readonly basis?: CommunityAveragesBasis;
  readonly group?: CommunityGroup;
  /** City sector from the community boundaries dataset (e.g. "CENTRE"). */
  readonly sector?: string;
  /** All residential dwelling records (condos included) — profile-page view. */
  readonly residential?: CommunityAverages;
}

export interface CommunityAggregatesFile {
  readonly generatedAt: string;
  readonly costDataVersion: string;
  /** Hash of the selection config the file was built from (#690). */
  readonly selectionHash?: string;
  readonly communities: readonly CommunityAggregate[];
}

/**
 * Community page type. `build-guide` communities get the single-family
 * build-cost guide; `profile` communities (condo/apartment-dominated, where
 * a per-house build figure would be misleading) get the property-values
 * profile instead.
 */
export type CommunityType = 'build-guide' | 'profile';

/** Dwelling-mix buckets, from City assessment `sub_property_use` codes. */
export type DwellingBucket = 'singleDetached' | 'semiDuplex' | 'multiFamily';

export interface CommunityDwellingMix {
  /** kebab-case, matches community-aggregates.json. */
  readonly slug: string;
  readonly communityType: CommunityType;
  /** Residential dwelling assessment records (excludes condo common elements, parking, storage). */
  readonly dwellingUnits: number;
  readonly mix: Readonly<Record<DwellingBucket, number>>;
  readonly mostCommonType: DwellingBucket;
}

export interface CommunityMixFile {
  readonly generatedAt: string;
  /** Assessment roll year the mix was computed from, e.g. "2026". */
  readonly assessmentYear: string;
  readonly communities: readonly CommunityDwellingMix[];
}

/**
 * Slim slug → page-type lookup (`community-types.json`).
 * The community index and the community-page variant chooser import this
 * (~1 KB) instead of the full mix file; the full mix is only loaded by the
 * lazily-loaded profile variant.
 */
export interface CommunityTypesFile {
  readonly generatedAt: string;
  /** Assessment roll year the mix was computed from, e.g. "2026". */
  readonly assessmentYear: string;
  /** slug → page type. Unknown slugs default to 'build-guide'. */
  readonly types: Readonly<Record<string, CommunityType>>;
}

/**
 * View model for one property-profile community page. All figures are real
 * City assessment data. Built by the route component, rendered by the
 * lazily-loaded profile variant.
 */
export interface CommunityProfileView {
  readonly slug: string;
  readonly displayName: string;
  /** All-residential average City-assessed value (same figure as the index card). */
  readonly avgAssessedValue: number;
  /** Assessment roll year, e.g. "2026". */
  readonly assessmentYear: string;
  /** Residential dwelling records behind the mix (excludes common elements/parking/storage). */
  readonly dwellingUnits: number;
  readonly mix: Readonly<Record<DwellingBucket, number>>;
  readonly mostCommonType: DwellingBucket;
  /** Up to 3 nearby community slugs (display names resolved from the aggregates). */
  readonly nearby: readonly { slug: string; displayName: string }[];
  /** Hand-written, community-specific introduction (established infill communities). */
  readonly intro?: string;
}

/**
 * Raw profile copy as stored in `community-profile-copy.defaults.ts`.
 * `statLabel`/`statNote` are intentionally absent: the route component
 * merges the build-guide's assessed-value wording over the raw copy (same
 * figure, same wording, one source of truth) before resolving placeholders.
 */
export type RawCommunityProfileCopy = Omit<CommunityProfileCopy, 'statLabel' | 'statNote'>;

/**
 * Resolved profile copy — raw copy with every {name}, {year},
 * {avgAssessed}, {multiPct}, {semiPct}, {singlePct} placeholder filled by
 * `resolveProfileCopy`. Never render the raw copy.
 */
export interface CommunityProfileCopy {
  readonly kicker: string;
  readonly titleTemplate: string;
  readonly descriptionTemplate: string;
  readonly lede: string;
  /** Bold lead clause rendered before the lede (no placeholder). */
  readonly ledeLead: string;
  /** Hero label above the property's assessed value. */
  readonly propertyValueLabel: string;
  /** Comparison-row label, e.g. "{name} average". */
  readonly communityAverageLabel: string;
  /** Short tag for the property bar in the comparison chart. */
  readonly comparePropertyTag: string;
  /** Caption under the comparison bars. */
  readonly compareBarCaption: string;
  /**
   * aria-label template for the comparison bars. {name} and {avgAssessed}
   * are filled by resolveProfileCopy; {propertyValue} is filled at render
   * time from the transient property context.
   */
  readonly compareBarLabelTemplate: string;
  /** Compact honest note under the hero (assessment roll + tax-purpose). */
  readonly honestNote: string;
  /** Hero label for direct visits (no property context): "{name} average assessed value". */
  readonly averageHeroLabel: string;
  readonly homesAssessedLabel: string;
  readonly homesAssessedSub: string;
  readonly mostCommonTypeLabel: string;
  readonly assessmentYearLabel: string;
  readonly mixTitle: string;
  readonly mixBody: string;
  readonly mixBarLabelTemplate: string;
  readonly typeLabels: Readonly<Record<DwellingBucket, string>>;
  readonly noBuildTitle: string;
  readonly noBuildBody: string;
  readonly noBuildGuideLink: string;
  readonly explainerTitle: string;
  readonly explainerItems: readonly { title: string; body: string }[];
  readonly faqTitle: string;
  readonly faqItems: readonly { q: string; a: string }[];
  readonly nearbyTitle: string;
  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaEstimateLabel: string;
  readonly ctaGuideLabel: string;
  readonly finePrint: string;
  /**
   * Assessed-value label/note. Not stored with the raw copy — the route
   * component merges the guide's wording over the raw copy (same figure,
   * same wording, one source of truth) before resolving placeholders.
   */
  readonly statLabel: string;
  readonly statNote: string;
}

/**
 * One card on the community index (#690), from the generated
 * `community-index.json`: just what the card needs, so the index route
 * doesn't bundle every community's full aggregates.
 */
export interface CommunityIndexEntry {
  readonly slug: string;
  /** Display name as the City dataset spells it (e.g. "ALTADORE"). */
  readonly name: string;
  readonly type: CommunityType;
  readonly group: CommunityGroup;
  /** The figures its page shows (guide: single/semi-detached homes; profile: all residential dwellings). */
  readonly count: number;
  readonly avgAssessedValue: number;
  readonly avgLotSqft: number;
}

export interface CommunityIndexFile {
  /** When the underlying aggregates were generated (ISO-8601). */
  readonly generatedAt: string;
  readonly communities: readonly CommunityIndexEntry[];
}
