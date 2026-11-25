import { inject } from '@angular/core';
import type { DesignationGradeBand, SchoolType } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { mergeLazyCopy } from '../../core/config/lazy-copy';
import type { SchoolTypeFilter } from './community-guide.state';
import { DEFAULT_COMMUNITY_GUIDE_COPY } from './community-guide-copy.defaults';

/** One school level group on the Schools tab. */
export interface SchoolLevelCopy {
  readonly key: string;
  readonly label: string;
  /** Lower-case fragments matched against the school's `grades` text. */
  readonly match: readonly string[];
}

/**
 * Community guide Schools + Living nearby tab copy (#781),
 * `copy.communities.guideTabs` in app-config.json. Placeholders: {name} is
 * the community display name.
 */
export interface CommunityGuideCopy {
  readonly tabsLabel: string;
  readonly tabs: { readonly overview: string; readonly schools: string; readonly living: string };
  readonly schools: {
    readonly title: string;
    readonly intro: string;
    readonly designatedTitle: string;
    /** "typically designated" notice; {name}. */
    readonly designatedNotice: string;
    readonly designatedEmpty: string;
    readonly lookupLinkTemplate: string;
    readonly gradeBandLabels: Readonly<Record<DesignationGradeBand, string>>;
    readonly filterLabel: string;
    readonly filters: readonly { readonly key: SchoolTypeFilter; readonly label: string }[];
    readonly typeLabels: Readonly<Record<SchoolType, string>>;
    readonly levels: readonly SchoolLevelCopy[];
    readonly otherLevelLabel: string;
    readonly programsLabel: string;
    readonly programLabels: Readonly<Record<string, string>>;
    readonly provincialLabel: string;
    readonly testLabels: Readonly<Record<string, string>>;
    /** {acceptable}, {excellence}. */
    readonly testResultTemplate: string;
    readonly enrolmentLabel: string;
    /** {enrolment}, {capacity}, {pct}, {year}. */
    readonly enrolmentTemplate: string;
    readonly fraserLabel: string;
    /** {score}, {year}. */
    readonly fraserTemplate: string;
    readonly sourceLinkLabel: string;
    readonly notAvailable: string;
    readonly tuitionNote: string;
    readonly addToComparison: string;
    readonly inComparison: string;
    readonly comparisonFull: string;
    readonly emptyFiltered: string;
    readonly emptyAll: string;
    readonly loading: string;
    readonly error: string;
    readonly retry: string;
    readonly mapNote: string;
  };
  readonly living: {
    readonly title: string;
    /** {name}. */
    readonly intro: string;
    readonly distanceNote: string;
    readonly nearestLabel: string;
    /** {place}, {distance}. */
    readonly nearestTemplate: string;
    /** Display unit conversion: distances at or over this many metres show in km. */
    readonly metresPerKm: number;
    /** {radius}. */
    readonly noneWithin: string;
    /** {count}, {radius}. */
    readonly countWithin: string;
    readonly treeCoverLabel: string;
    readonly treeLevels: Readonly<Record<'low' | 'moderate' | 'high', string>>;
    /** {trees}. */
    readonly treesPerHaTemplate: string;
    readonly treeNote: string;
    /** {date}. */
    readonly refreshedTemplate: string;
    readonly loading: string;
    readonly error: string;
    readonly retry: string;
  };
}

/**
 * Lazy copy (#980 pattern): the compiled defaults ship in the community
 * page's lazy chunk, merged with deploy overrides at
 * `copy.communities.guideTabs`. Call in an injection context.
 */
export function injectCommunityGuideCopy(): CommunityGuideCopy {
  return mergeLazyCopy(inject(ConfigService), DEFAULT_COMMUNITY_GUIDE_COPY, [
    'communities',
    'guideTabs',
  ]);
}
