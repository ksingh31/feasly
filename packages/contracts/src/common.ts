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
  readonly high: number;
}

/**
 * Placeholder returned pre-gate so real figures never reach the client.
 * The UI renders blur + lock icon for these; view-source reveals nothing.
 */
export interface BlurredFigure {
  readonly blurred: true;
}

/** Any figure the UI may render: a real range, or a pre-gate placeholder. */
export type Figure = CostRange | BlurredFigure;
