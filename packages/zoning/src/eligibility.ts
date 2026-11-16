/**
 * Estimator eligibility, derived from the catalogue (#911).
 *
 * Owner decision (2026-11-15, delegated): the zoning catalogue is the single
 * source of truth for which districts get a single-family quote. A district
 * is quotable when its catalogue entry has a VERIFIED (cited) single-detached
 * form that is permitted or discretionary. Discretionary districts are quoted
 * with a "needs City approval" note, never as a sure thing. A district with
 * no cited single-detached entry is not quotable until one is added.
 * Site-specific districts (Direct Control) stay fail-open: quoted, because
 * the parcel's own bylaw decides and they are common on greenfield lots.
 *
 * Pure: no I/O, no clock, no dollars.
 */
import type { ZoningRulesVersion } from '@feasly/contracts';

export interface SingleDetachedEligibility {
  /**
   * Every quotable district code (permitted, discretionary and
   * site-specific), in catalogue order. Canonical codes only — the City's
   * `land_use_designation` uses them.
   */
  readonly quotable: readonly string[];
  /** Subset of `quotable` where single-detached is a discretionary use (needs City approval). */
  readonly discretionary: readonly string[];
}

export function singleDetachedEligibility(version: ZoningRulesVersion): SingleDetachedEligibility {
  const quotable: string[] = [];
  const discretionary: string[] = [];
  for (const d of version.districts) {
    if (d.coverage === 'site-specific') {
      quotable.push(d.code);
      continue;
    }
    if (d.coverage !== 'covered') continue;
    const sd = d.forms.find((f) => f.form === 'single-detached' && f.verified);
    if (!sd) continue;
    quotable.push(d.code);
    if (sd.permission === 'discretionary') discretionary.push(d.code);
  }
  return { quotable, discretionary };
}
