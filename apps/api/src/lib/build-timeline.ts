/**
 * Typical custom-infill build timeline by city (#823).
 *
 * Owner decision (Karan, 2026-11-15): a custom infill build typically takes
 * 12–16 months from design through permits to completion. Phase ranges are
 * typical and overlap (design wraps up while the development permit is in
 * review), so the total is stated, never summed. The report email renders
 * this; the web app carries the same figures in its config
 * (`buildTimeline.cities` in app-config.defaults.ts) — keep them in step.
 * A new city = one entry here keyed like `ZONING_CITY`. Permit phases can
 * later be fed from real City approval times (permits story).
 *
 * Pure data: no I/O, no clock, no env. No dollar figures.
 */

export interface BuildTimelinePhase {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly unit: 'weeks' | 'months';
}

export interface BuildTimeline {
  readonly totalMinMonths: number;
  readonly totalMaxMonths: number;
  /** Phases in display order. */
  readonly phases: readonly BuildTimelinePhase[];
}

export const BUILD_TIMELINES: Readonly<Record<string, BuildTimeline>> = {
  calgary: {
    totalMinMonths: 12,
    totalMaxMonths: 16,
    phases: [
      { id: 'design', label: 'Design and architecture', min: 2, max: 4, unit: 'months' },
      { id: 'development-permit', label: 'Development permit', min: 2, max: 4, unit: 'months' },
      { id: 'building-permit', label: 'Building permit', min: 1, max: 2, unit: 'months' },
      { id: 'demolition', label: 'Demolition', min: 2, max: 4, unit: 'weeks' },
      { id: 'construction', label: 'Construction', min: 7, max: 10, unit: 'months' },
      { id: 'completion', label: 'Final inspections and completion', min: 2, max: 4, unit: 'weeks' },
    ],
  },
};

/** The city's timeline, or undefined when none is configured (section omitted). */
export function resolveBuildTimeline(
  city: string,
  timelines: Readonly<Record<string, BuildTimeline>> = BUILD_TIMELINES,
): BuildTimeline | undefined {
  return timelines[city.trim().toLowerCase()];
}

/** "2–4 months" / "2–4 weeks". */
export function formatPhaseRange(phase: BuildTimelinePhase): string {
  return `${phase.min}–${phase.max} ${phase.unit}`;
}

/** "Typical total: 12–16 months". */
export function formatTimelineTotal(timeline: BuildTimeline): string {
  return `Typical total: ${timeline.totalMinMonths}–${timeline.totalMaxMonths} months`;
}

/** Exact owner copy (#823). */
export const PRESALE_TIMELINE_NOTE =
  'Buying a pre-sale or move-in-ready home follows a different timeline.';
