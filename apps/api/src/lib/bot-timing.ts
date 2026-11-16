/**
 * #788 — minimum time-to-submit (invisible bot protection).
 *
 * The lead gate reports how long the form was on screen before submit
 * (`elapsedMs`, measured client-side from render). Scripts post instantly;
 * people take seconds to type a name and email. A submission faster than
 * the configured minimum is treated like the HRD-03 honeypot: quarantined
 * with an identical 201 response.
 *
 * Pure: no clock, no env — the threshold comes from config.
 */

/**
 * True when the submission arrived faster than `minSubmitMs`.
 *
 * - `minSubmitMs <= 0` disables the check.
 * - A missing `elapsedMs` is NOT too fast: agent-API / MCP callers and
 *   web bundles cached from before #788 never send it, and blocking them
 *   would break real integrations. Those paths stay covered by the
 *   honeypot and the shared rate limits.
 * - A non-finite or negative value is a forged/garbled timer: too fast.
 */
export function isTooFastSubmission(
  elapsedMs: number | undefined,
  minSubmitMs: number,
): boolean {
  if (minSubmitMs <= 0) return false;
  if (elapsedMs === undefined) return false;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return true;
  return elapsedMs < minSubmitMs;
}
