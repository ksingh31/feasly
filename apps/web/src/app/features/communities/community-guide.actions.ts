import type { SchoolTypeFilter } from './community-guide.state';

/** Guide tabs (#781). */
export type CommunityGuideTab = 'overview' | 'schools' | 'living';

/** Resets the guide for a (new) community slug — the page component is reused across slugs (#783). */
export class OpenCommunityGuide {
  static readonly type = '[Community guide] Open';
  constructor(public readonly slug: string) {}
}

export class SelectCommunityGuideTab {
  static readonly type = '[Community guide] Select tab';
  constructor(public readonly tab: CommunityGuideTab) {}
}

export class SetSchoolTypeFilter {
  static readonly type = '[Community guide] Set school type filter';
  constructor(public readonly filter: SchoolTypeFilter) {}
}

/** Loads designations + the community's schools once per slug. */
export class LoadCommunitySchools {
  static readonly type = '[Community guide] Load schools';
}

/** Loads the living-nearby metrics once per slug. */
export class LoadCommunityLiving {
  static readonly type = '[Community guide] Load living';
}
