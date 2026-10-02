/**
 * Community profile actions.
 *
 * When the estimator's coverage gate rejects an address, the user is
 * redirected to their community's profile page instead of a dead-end
 * message. These actions carry the rejected property's context (address +
 * assessed value) so the profile can show "this property vs community
 * average". Transient by design — never persisted.
 */

/** Property context for the profile page's "this property" card. */
export interface ProfilePropertyContext {
  /** Display address, e.g. "1017 11 Ave SW, Calgary, AB". */
  readonly address: string;
  /** City-assessed value, integer CAD. */
  readonly assessedValue: number;
}

export class SetProfilePropertyContext {
  static readonly type = '[CommunityProfile] Set property context';
  constructor(public readonly context: ProfilePropertyContext) {}
}

export class ClearProfilePropertyContext {
  static readonly type = '[CommunityProfile] Clear property context';
}
