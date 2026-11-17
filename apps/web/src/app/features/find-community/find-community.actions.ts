import type { MatchFilterKey, MatchSelection } from './match-selection';

/** Find a community actions (#779). */

/** Replaces the whole selection (a shared link, or a saved one). */
export class SetMatchSelection {
  static readonly type = '[Find community] Set selection';
  constructor(public readonly selection: MatchSelection) {}
}

/** One tap on a priority chip: off → nice → must → off. */
export class CycleMatchPriority {
  static readonly type = '[Find community] Cycle priority';
  constructor(public readonly key: string) {}
}

/** One tap on a build-filter chip: on/off. */
export class ToggleMatchFilter {
  static readonly type = '[Find community] Toggle filter';
  constructor(public readonly key: MatchFilterKey) {}
}

/** Ranks communities for the current selection (one API call). */
export class LoadCommunityMatches {
  static readonly type = '[Find community] Load matches';
}

/** Ticks/unticks a community for the compare tray (max from config). */
export class ToggleMatchCompare {
  static readonly type = '[Find community] Toggle compare';
  constructor(public readonly communityCode: string) {}
}

/** Empties the compare tray. */
export class ClearMatchCompare {
  static readonly type = '[Find community] Clear compare';
}
