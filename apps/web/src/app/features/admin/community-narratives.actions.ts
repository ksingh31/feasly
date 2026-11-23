/**
 * Community narratives ops actions (#915). All panel state lives in
 * CommunityNarrativesState — the component dispatches and renders
 * selectors, never calls the API directly.
 */

/** Load every community's latest narrative period, status and attempts. */
export class LoadCommunityNarratives {
  static readonly type = '[CommunityNarratives] Load';
}

/**
 * "Regenerate now" — one community when `communitySlug` is given, every
 * community otherwise. Ignored while another regenerate is in flight.
 */
export class RegenerateCommunityNarratives {
  static readonly type = '[CommunityNarratives] Regenerate';
  constructor(public readonly communitySlug?: string) {}
}
