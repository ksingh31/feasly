/**
 * Email provider abstraction (story email/01).
 *
 * One interface every mail sender implements. The provider is ACS
 * (Karan-approved 2026-09-24): the log provider handles dev/test, and every
 * real adapter fails closed with a clear configuration error until its
 * credentials are configured. Nothing outside this module constructs a
 * provider; composition.ts chooses based on typed config.
 */

/** A fully-rendered message ready for a provider to send. */
export interface EmailMessage {
  readonly to: string;
  /** RFC 5322 subject, no newlines. */
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** e.g. List-Unsubscribe for non-transactional mail. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EmailSendResult {
  /** Which provider accepted the message. */
  readonly provider: 'log' | 'postmark' | 'acs';
  /** Provider-assigned id, when the provider returns one. */
  readonly messageId?: string;
}

/** Machine-readable email failure classification, for retry decisions + UX copy. */
export type EmailFailureCode = 'invalid-recipient' | 'delivery-failed';

/** Thrown when a provider is misconfigured or refuses the send. */
export class EmailProviderError extends Error {
  /**
   * True when the send may succeed on retry (timeouts, 429, 5xx, network
   * errors). False for permanent failures (invalid recipient, rejected
   * sender). Defaults to true — unknown errors are retried, never silently
   * dropped as permanent (Karan 2026-09-27).
   */
  readonly retryable: boolean;
  /**
   * Why the send failed, for UX copy selection. 'invalid-recipient' means
   * the address itself was rejected — the user should check for typos, not
   * "check their inbox". Everything else is 'delivery-failed'.
   */
  readonly failureCode: EmailFailureCode;
  /**
   * True when the provider ACCEPTED the message (e.g. ACS beginSend
   * succeeded) but the outcome couldn't be confirmed — delivery polling
   * timed out or errored. Re-sending would likely duplicate an already
   * delivered email (P0 2026-09-27: triple "estimate is ready" emails), so
   * this error is never retried and callers should treat the send as "maybe
   * delivered" (record it for resubmit suppression, tell the user to check
   * their inbox). False/undefined = nothing was accepted — retry is safe.
   */
  readonly sendAccepted?: boolean;
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      failureCode?: EmailFailureCode;
      sendAccepted?: boolean;
    },
  ) {
    super(message, options);
    this.name = 'EmailProviderError';
    this.retryable = options?.retryable ?? true;
    this.failureCode = options?.failureCode ?? 'delivery-failed';
    this.sendAccepted = options?.sendAccepted;
  }
}

export interface EmailProvider {
  readonly name: 'log' | 'postmark' | 'acs';
  send(message: EmailMessage): Promise<EmailSendResult>;
}
