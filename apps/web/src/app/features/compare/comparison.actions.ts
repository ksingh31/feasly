import type { FinishTier } from '@feasly/contracts';

/**
 * Comparison actions (NBH-03). All comparison result state lives in
 * ComparisonState — components dispatch and render selectors, never call
 * the API directly.
 */
export class RunComparison {
  static readonly type = '[Comparison] Run';
}

/** Post-gate tier what-if: re-runs every row-set inline at the new tier. */
export class ReviseComparisonTier {
  static readonly type = '[Comparison] Revise tier';
  constructor(public readonly tier: FinishTier) {}
}

/**
 * Marks the comparison unlocked after the lead gate converts. The unlock is
 * the successful lead submission — the comparison endpoint is public and
 * returns full ranges, so (unlike the magic-link report) there is no
 * separate token verification step. Memory-only: stripped before storage
 * persistence, like the report token.
 */
export class ComparisonLeadSubmitted {
  static readonly type = '[Comparison] Lead submitted';
  constructor(public readonly leadId: string) {}
}

/** Resets the comparison result (e.g. when the picker inputs change). */
export class ClearComparisonResult {
  static readonly type = '[Comparison] Clear result';
}
