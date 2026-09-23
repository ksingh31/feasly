/**
 * Shared primitives. Everything the client renders arrives as one of these —
 * the UI never computes money, it only displays what the API returned.
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

export function isBlurred(f: Figure): f is BlurredFigure {
  return (f as BlurredFigure).blurred === true;
}

export function isCostRange(f: Figure): f is CostRange {
  return !isBlurred(f);
}
