/**
 * Azure Communication Services email provider (story email/01).
 *
 * Real adapter over the official `@azure/communication-email` SDK
 * (EmailClient). Karan approved ACS as the provider on 2026-09-24.
 *
 * Wiring: `EMAIL_ACS_CONNECTION_STRING` (config, Key Vault reference in
 * staging/production — never committed; the secrets-hygiene tripwire fails
 * the build if a connection-string literal ever lands in this module). A
 * missing connection string fails closed at send time naming the exact env
 * var. The sender identity (`fromAddress`) must be an ACS-verified domain
 * sender — until the sender domain is confirmed, sends fail with the
 * provider's own clear error, which is the correct placeholder behavior
 * (no provisioning, no DNS changes, no spend in this story).
 *
 * Long-running send: beginSend + pollUntilDone. SDK errors are wrapped in
 * EmailProviderError with the connection string and any recipient addresses
 * redacted out of the message — never leak credentials or PII in errors.
 *
 * The endpoint is derived from the connection string by the SDK — no URL
 * literals here (the layer-boundary test forbids them in services/).
 */
import {
  EmailClient,
  type EmailMessage as AcsEmailMessage,
} from '@azure/communication-email';
import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from '../email.types';

export interface AcsEmailProviderDeps {
  /**
   * ACS connection string — from EMAIL_ACS_CONNECTION_STRING (Key Vault
   * reference in staging/production). Absent = fail-closed sends.
   */
  readonly connectionString?: string;
  /** Sender identity; must be an ACS-verified domain sender to deliver. */
  readonly fromAddress: string;
}

/** Redact credential fragments and email addresses from SDK error text. */
function sanitizeErrorText(text: string): string {
  return text
    .replace(/endpoint=[^;'"`\s]+;accesskey=[^;'"`\s]+/gi, '[redacted-connection-string]')
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      '[redacted-recipient]',
    );
}

function toProviderError(context: string, error: unknown): EmailProviderError {
  const raw =
    error instanceof Error ? error.message : 'unknown error';
  return new EmailProviderError(
    `Azure Communication Services email failed (${context}): ${sanitizeErrorText(raw)}`,
    { cause: error },
  );
}

export function createAcsEmailProvider(
  deps: AcsEmailProviderDeps,
): EmailProvider {
  return {
    name: 'acs',
    async send(message: EmailMessage): Promise<EmailSendResult> {
      if (!deps.connectionString) {
        throw new EmailProviderError(
          'Azure Communication Services email is not configured: set ' +
            'EMAIL_ACS_CONNECTION_STRING (via a Key Vault reference in ' +
            'staging/production; never commit the connection string).',
        );
      }
      const client = new EmailClient(deps.connectionString);
      const acsMessage: AcsEmailMessage = {
        senderAddress: deps.fromAddress,
        content: {
          subject: message.subject,
          plainText: message.text,
          html: message.html,
        },
        recipients: {
          to: [{ address: message.to }],
        },
        ...(message.headers ? { headers: { ...message.headers } } : {}),
      };
      let poller;
      try {
        poller = await client.beginSend(acsMessage);
      } catch (error) {
        throw toProviderError('send rejected', error);
      }
      let result;
      try {
        result = await poller.pollUntilDone();
      } catch (error) {
        throw toProviderError('delivery polling failed', error);
      }
      if (result.status !== 'Succeeded') {
        const detail = result.error?.message
          ? sanitizeErrorText(result.error.message)
          : `status ${result.status}`;
        throw new EmailProviderError(
          `Azure Communication Services email was not delivered (${detail}).`,
        );
      }
      return { provider: 'acs', messageId: result.id };
    },
  };
}
