/**
 * Postmark email provider (story email/01).
 *
 * Real REST adapter for Postmark's single-send endpoint. Wired through
 * config but NEVER activated without credentials: a missing server token
 * fails closed with a configuration error naming the exact env var
 * (Key Vault reference in staging/production — never in the repo).
 *
 * The API endpoint is a config tunable (EMAIL_POSTMARK_ENDPOINT), not a
 * literal here — the layer-boundary test forbids URL literals in services/.
 *
 * Provider choice is still Karan's call; this adapter ships so the flip is
 * a config change, not a code change.
 */
import {
  EmailProviderError,
  type EmailFailureCode,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from '../email.types';

export interface PostmarkEmailProviderDeps {
  /** Postmark server token — from EMAIL_POSTMARK_SERVER_TOKEN (Key Vault). */
  readonly serverToken?: string;
  readonly fromAddress: string;
  /** From config EMAIL_POSTMARK_ENDPOINT. */
  readonly endpoint: string;
}

interface PostmarkResponse {
  readonly MessageID?: string;
  readonly Message?: string;
  /** Postmark API error code (e.g. 300 = invalid address, 406 = inactive recipient). */
  readonly ErrorCode?: number;
}

/**
 * Postmark failure classification (Karan 2026-09-27): wrong email addresses
 * must NOT be retried. Postmark answers 422 with an ErrorCode for bad
 * addresses (300/406 = recipient problems); 429/5xx stay retryable.
 */
function classifyPostmarkRejection(
  status: number,
  errorCode: number | undefined,
  message: string | undefined,
): { retryable: boolean; failureCode: EmailFailureCode } {
  if (status === 429 || status >= 500) {
    return { retryable: true, failureCode: 'delivery-failed' };
  }
  const invalidRecipient =
    errorCode === 300 ||
    errorCode === 406 ||
    /invalid[\s_-]*(recipient|email|address)|inactive recipient|unknown user|mailbox/i.test(
      message ?? '',
    );
  return {
    retryable: false,
    failureCode: invalidRecipient ? 'invalid-recipient' : 'delivery-failed',
  };
}

export function createPostmarkEmailProvider(
  deps: PostmarkEmailProviderDeps,
): EmailProvider {
  return {
    name: 'postmark',
    async send(message: EmailMessage): Promise<EmailSendResult> {
      if (!deps.serverToken) {
        throw new EmailProviderError(
          'Postmark is not configured: set EMAIL_POSTMARK_SERVER_TOKEN ' +
            '(via a Key Vault reference in staging/production; never commit the token).',
          // Permanent misconfiguration — retrying won't help.
          { retryable: false, failureCode: 'delivery-failed' },
        );
      }
      let response: Response;
      try {
        response = await fetch(deps.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Postmark-Server-Token': deps.serverToken,
          },
          body: JSON.stringify({
            From: deps.fromAddress,
            To: message.to,
            Subject: message.subject,
            HtmlBody: message.html,
            TextBody: message.text,
            ...(message.headers ? { Headers: message.headers } : {}),
          }),
        });
      } catch (error) {
        // Network-level failure — transient.
        throw new EmailProviderError('Postmark request failed.', {
          cause: error,
          retryable: true,
          failureCode: 'delivery-failed',
        });
      }
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        let errorCode: number | undefined;
        let errorMessage: string | undefined;
        try {
          const body = (await response.json()) as PostmarkResponse;
          if (typeof body.ErrorCode === 'number') errorCode = body.ErrorCode;
          if (body.Message) {
            errorMessage = body.Message;
            detail += `: ${body.Message}`;
          }
        } catch {
          // Non-JSON error body — status is enough; never echo raw bodies
          // (they can contain the recipient address).
        }
        const classification = classifyPostmarkRejection(
          response.status,
          errorCode,
          errorMessage,
        );
        throw new EmailProviderError(
          `Postmark rejected the send (${detail}).`,
          classification,
        );
      }
      const body = (await response.json().catch(() => ({}))) as PostmarkResponse;
      return { provider: 'postmark', messageId: body.MessageID };
    },
  };
}
