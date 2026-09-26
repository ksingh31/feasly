/**
 * Shared primitives. Everything the client renders arrives as one of these —
 * the UI never computes money, it only displays what the API returned.
 *
 * Shapes only: no functions, no guards, no runtime of any kind. Consumers narrow
 * via the contract's own structure (e.g. the pre-gate vs post-gate estimate
 * types) — narrowing helpers belong in the consuming layer (UI shared utils,
 * API lib), never in this frozen seam.
 */

/** A closed CAD range. Integers, no cents — cents never leave the server. */
export interface CostRange {
  readonly low: number;
  /**
   * Deterministic best estimate from the cost model (not a client midpoint).
   * Invariant: low <= base <= high.
   */
  readonly base: number;
  readonly high: number;
}

/**
 * A single fixed CAD figure — not a range. Integers, no cents. Used for the
 * assessed land value, which is a City fact rather than an estimated range.
 * Assigning a CostRange where a FixedFigure is expected is a compile error.
 */
export interface FixedFigure {
  readonly value: number;
}

/**
 * Any figure the UI may render: a real range, or a fixed single value.
 * Pre-gate previews carry the same real computed figures as post-gate
 * estimates — the UI renders them blurred (CSS) until the lead gate
 * unlocks. The blur is a lead-capture nudge, not a security boundary:
 * figures are readable in the API response by design (2026-09-26).
 */
export type Figure = CostRange | FixedFigure;
