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

/** Thrown when a provider is misconfigured or refuses the send. */
export class EmailProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmailProviderError';
  }
}

export interface EmailProvider {
  readonly name: 'log' | 'postmark' | 'acs';
  send(message: EmailMessage): Promise<EmailSendResult>;
}
