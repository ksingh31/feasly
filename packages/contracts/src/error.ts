/**
 * Standard error envelope. `retryable` drives whether the UI shows a Retry button.
 */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Invisible bot challenge (#788). Sent only to an IP that recently tripped a
 * shared money/mail rate limit. Normal users never see it. `code` is
 * `CHALLENGE_REQUIRED` (no token sent) or `CHALLENGE_FAILED` (the token was
 * rejected or could not be verified; verification fails closed). The client
 * runs Turnstile in managed/invisible mode with `challenge.siteKey` and
 * retries with the token in the {@link BOT_CHALLENGE_HEADER} header.
 */
export interface ChallengeRequiredError extends ApiError {
  readonly challenge: {
    readonly provider: 'turnstile';
    /** Public Turnstile site key, from API config. Never hardcoded in the client. */
    readonly siteKey: string;
  };
}

/** Request header that carries a Turnstile token (#788). */
export const BOT_CHALLENGE_HEADER = 'X-Turnstile-Token';
