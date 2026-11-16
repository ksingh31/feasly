/**
 * #788 — invisible bot challenge, required only after a rate-limit trip.
 *
 * Owner decision (2026-11-15, #750): bot protection stays invisible. Normal
 * users never see a challenge. Only an IP that has tripped a shared
 * money/mail rate limit (lead capture, estimates) must pass Cloudflare
 * Turnstile (managed/invisible mode) for `windowMs` after the trip.
 *
 * - The trip mark is a {@link SharedCooldown}: Postgres-backed so every
 *   instance agrees, keyed by the SHA-256 of the client IP (never raw), with
 *   the per-instance fallback when the store errors.
 * - Verification FAILS CLOSED: a missing token, a rejected token, a timeout
 *   or any verifier error all deny the request.
 * - Middleware never does network I/O itself. The verifier is an injected
 *   interface; the Turnstile implementation lives in
 *   `services/turnstile.service.ts`.
 */
import { BOT_CHALLENGE_HEADER } from '@feasly/contracts';
import type { HeaderValue } from './correlation';
import { ErrorCodes, HttpError, toProblemDetails, type ProblemDetails } from './errors';
import type { AnyRateLimiter, SharedCooldown } from './shared-rate-limit';

/** Server-side check of a challenge token. Must never throw for a bad token. */
export interface ChallengeVerifier {
  /** True only when the provider confirmed the token. */
  verify(token: string, remoteIp: string | undefined): Promise<boolean>;
}

export type ChallengeOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'missing' | 'failed' };

export interface BotChallengeGate {
  /**
   * Called before the rate limiter. Allows the request when the key has
   * no active trip, or when the request carries a token the verifier
   * accepts.
   */
  check(args: {
    readonly key: string;
    readonly headers: Record<string, HeaderValue>;
    readonly clientIp: string | undefined;
  }): Promise<ChallengeOutcome>;
  /** Called when a limiter denies `key`: start (or extend) the trip window. */
  markTripped(key: string): Promise<void>;
  /** Public site key, returned in the challenge problem. */
  readonly siteKey: string;
}

export interface BotChallengeGateDeps {
  readonly trips: SharedCooldown;
  readonly verifier: ChallengeVerifier;
  readonly siteKey: string;
  /**
   * Caps outbound verifier calls per key (#788 review): a tripped IP
   * spraying junk tokens would otherwise trigger one siteverify round-trip
   * per request before any limiter runs. Every verification attempt counts;
   * over the cap the request is denied (`failed`) WITHOUT calling the
   * verifier. Optional so unit tests can omit it; composition always sets it.
   */
  readonly attempts?: AnyRateLimiter;
}

/** Turnstile tokens are at most 2048 characters; anything longer is junk. */
const MAX_TOKEN_LENGTH = 2048;

/** Case-insensitive header read (Functions lower-cases, tests may not). */
export function readChallengeToken(
  headers: Record<string, HeaderValue>,
): string | undefined {
  const wanted = BOT_CHALLENGE_HEADER.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const token = typeof raw === 'string' ? raw.trim() : '';
    return token === '' ? undefined : token;
  }
  return undefined;
}

/**
 * Agent-API callers authenticate with a Bearer API key and cannot solve a
 * browser challenge. Requests carrying `Authorization: Bearer …` skip the
 * gate (check AND trip marking); the IP limiter still applies to them.
 * This is the SAME predicate the per-key API middleware uses, so anything
 * exempted here is guaranteed to be key-checked there (a forged value gets
 * a 401 before any handler work). Never fork it (#788 review).
 */
export { hasBearerCredential } from './session-token';

export function createBotChallengeGate(deps: BotChallengeGateDeps): BotChallengeGate {
  const { trips, verifier, siteKey, attempts } = deps;
  return {
    siteKey,
    async check({ key, headers, clientIp }) {
      if (!(await trips.isActive(key))) return { allowed: true };
      const token = readChallengeToken(headers);
      if (token === undefined) return { allowed: false, reason: 'missing' };
      if (token.length > MAX_TOKEN_LENGTH) return { allowed: false, reason: 'failed' };
      if (attempts && !(await attempts.check(key)).allowed) {
        return { allowed: false, reason: 'failed' }; // over the cap: no verifier call
      }
      let ok = false;
      try {
        ok = await verifier.verify(token, clientIp);
      } catch {
        ok = false; // fail closed
      }
      return ok ? { allowed: true } : { allowed: false, reason: 'failed' };
    },
    async markTripped(key) {
      await trips.start(key);
    },
  };
}

/**
 * 403 telling the client to run the invisible challenge and retry with the
 * token. Not retryable as-is: the client must attach a fresh token.
 */
export function challengeRequiredProblem(
  correlationId: string,
  reason: 'missing' | 'failed',
  siteKey: string,
): ProblemDetails {
  const code =
    reason === 'missing' ? ErrorCodes.CHALLENGE_REQUIRED : ErrorCodes.CHALLENGE_FAILED;
  return {
    ...toProblemDetails(
      new HttpError(403, code, 'Please confirm you are not a bot, then try again.', false),
      correlationId,
    ),
    challenge: { provider: 'turnstile', siteKey },
  };
}
