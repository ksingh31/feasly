/**
 * Lead scoring heuristic, v1 (consumer/02).
 *
 * Pure function: no I/O, no clock, no db. Recomputed from the latest
 * submission every time the 90-day dedupe rule updates an existing lead,
 * and set once at capture for new leads.
 *
 * The heuristic is deliberately simple and documented here so Karan can
 * retune it without reading call sites:
 *
 * - timeline urgency dominates (a "0-3 months" homeowner is the hottest
 *   signal we collect): 0-3mo = 40, 3-6mo = 30, 6-12mo = 20, 12+mo = 10,
 *   anything else (exploring / unknown) = 5.
 * - marketing consent +10: an opted-in lead can be nurtured.
 * - phone on file +10: reachable beats email-only.
 * - estimate total base >= $1,000,000 +10: bigger projects are worth
 *   chasing first. (Band, not the exact figure — the score must not leak
 *   estimate precision into the admin list view.)
 *
 * Max 70. Unknown timeline strings score like "exploring" rather than
 * throwing — the score must never fail a lead capture.
 */
export interface LeadScoreInput {
  readonly timeline: string;
  readonly marketingConsent: boolean;
  readonly hasPhone: boolean;
  /** Whole CAD dollars, e.g. the estimate's total-base. Optional. */
  readonly estimateTotalBase?: number;
}

const TIMELINE_POINTS: Readonly<Record<string, number>> = {
  '0-3mo': 40,
  '3-6mo': 30,
  '6-12mo': 20,
  '12+mo': 10,
  exploring: 5,
};

const HIGH_VALUE_THRESHOLD_CAD = 1_000_000;

export function computeLeadScore(input: LeadScoreInput): number {
  const timelinePoints = TIMELINE_POINTS[input.timeline] ?? 5;
  const consentPoints = input.marketingConsent ? 10 : 0;
  const phonePoints = input.hasPhone ? 10 : 0;
  const valuePoints =
    input.estimateTotalBase !== undefined &&
    Number.isFinite(input.estimateTotalBase) &&
    input.estimateTotalBase >= HIGH_VALUE_THRESHOLD_CAD
      ? 10
      : 0;
  return timelinePoints + consentPoints + phonePoints + valuePoints;
}
