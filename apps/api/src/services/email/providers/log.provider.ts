/**
 * Log email provider (story email/01).
 *
 * Dev/test transport: renders the send to the console instead of the
 * network. Preserves the standing dev behavior — magic links are LOGGED,
 * never rendered in UI.
 *
 * Safety rails:
 *  - Refuses to run in production (fail-closed: real mail needs a real
 *    provider, chosen by Karan).
 *  - PII discipline: logs the template subject + recipient domain only.
 *    Full bodies/links are logged ONLY when `logLinks` is on, which
 *    composition enables from EMAIL_LOG_LINKS (default true in dev/test).
 */
import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from '../email.types';

export interface LogEmailProviderDeps {
  readonly env: 'development' | 'test' | 'staging' | 'production';
  readonly logLinks: boolean;
}

function recipientDomain(to: string): string {
  const at = to.lastIndexOf('@');
  return at >= 0 ? to.slice(at + 1) : '(invalid)';
}

export function createLogEmailProvider(deps: LogEmailProviderDeps): EmailProvider {
  if (deps.env === 'production') {
    throw new EmailProviderError(
      'The log email provider is dev/test-only and refuses to run in production. ' +
        'Set EMAIL_PROVIDER to a real provider (acs is the approved provider; ' +
          'it needs EMAIL_ACS_CONNECTION_STRING from a provisioned ACS resource).',
    );
  }
  return {
    name: 'log',
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const redacted = `to=<redacted>@${recipientDomain(message.to)}`;
      if (deps.logLinks) {
        console.log(
          `[email:log] subject="${message.subject}" ${redacted} to="${message.to}"`,
        );
        console.log(`[email:log] text body:\n${message.text}`);
      } else {
        console.log(
          `[email:log] subject="${message.subject}" ${redacted} (body redacted; set EMAIL_LOG_LINKS=true to log links)`,
        );
      }
      return { provider: 'log' };
    },
  };
}
