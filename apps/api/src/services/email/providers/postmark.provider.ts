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
        throw new EmailProviderError('Postmark request failed.', { cause: error });
      }
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as PostmarkResponse;
          if (body.Message) detail += `: ${body.Message}`;
        } catch {
          // Non-JSON error body — status is enough; never echo raw bodies
          // (they can contain the recipient address).
        }
        throw new EmailProviderError(`Postmark rejected the send (${detail}).`);
      }
      const body = (await response.json().catch(() => ({}))) as PostmarkResponse;
      return { provider: 'postmark', messageId: body.MessageID };
    },
  };
}
