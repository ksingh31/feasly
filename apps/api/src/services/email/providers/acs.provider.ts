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
 * Long-running send: beginSend + pollUntilDone with a bounded deadline
 * (deliveryPollTimeoutMs — the SDK poller accepts an abortSignal but no
 * timeout of its own). SDK errors are wrapped in
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
  type EmailFailureCode,
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
  /**
   * Deadline for the delivery poll, in milliseconds. The send is
   * synchronous in the HTTP request path, so an unbounded
   * `pollUntilDone()` stalls the response when ACS's polling endpoint
   * hangs (2026-09-27: lead-gate "Sending..." hang). Past the deadline the
   * poll is aborted via the SDK's abortSignal and the send fails LOUD
   * (EmailProviderError) — the lead row and token are already committed
   * upstream, so a client retry is safe (dedupe live-link path, no
   * duplicate email). Defaults to 6s.
   */
  readonly deliveryPollTimeoutMs?: number;
}

/** Default delivery-poll deadline when the dep is not supplied. */
const DEFAULT_DELIVERY_POLL_TIMEOUT_MS = 6_000;

/** Redact credential fragments, email addresses, and raw magic-link tokens from SDK error text. */
function sanitizeErrorText(text: string): string {
  return text
    .replace(/endpoint=[^;'"`\s]+;accesskey=[^;'"`\s]+/gi, '[redacted-connection-string]')
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      '[redacted-recipient]',
    )
    // Magic-link tokens are 64 hex chars (two dash-stripped UUIDs —
    // magic-link.store.ts `issue`). They must never reach logs or errors.
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-token]');
}

/**
 * Structured send-failure event name, emitted as a JSON log line on every
 * provider throw. The Functions host captures console output into
 * Application Insights (`AppTraces`), and the
 * `${namePrefix}-email-send-failures` scheduled query rule in
 * `infra/bicep/modules/alerts.bicep` keys its alert query off this exact
 * string — rename it only together with the Bicep query (the
 * `email.send-failure-alert.test.ts` drift guard fails otherwise).
 *
 * The line carries NO PII: the error text is sanitized (credentials and
 * recipient addresses redacted), and the message body/subject/recipient
 * are never included. The HTTP request paths also hit the pipeline's error
 * log, which carries the correlation ID — correlate by timestamp.
 */
export const EMAIL_SEND_FAILED_EVENT = 'email.send-failed';

function logSendFailure(context: string, sanitizedError: string): void {
  console.error(
    JSON.stringify({
      event: EMAIL_SEND_FAILED_EVENT,
      provider: 'acs',
      context,
      error: sanitizedError,
    }),
  );
}

function toProviderError(context: string, error: unknown): EmailProviderError {
  const raw =
    error instanceof Error ? error.message : 'unknown error';
  const sanitized = sanitizeErrorText(raw);
  logSendFailure(context, sanitized);
  const classification = classifyAcsError(error);
  return new EmailProviderError(
    `Azure Communication Services email failed (${context}): ${sanitized}`,
    { cause: error, ...classification },
  );
}

/**
 * Failure classification (Karan 2026-09-27): wrong email addresses must NOT
 * be retried. The Azure SDK surfaces HTTP failures as RestError with a
 * `statusCode` (possibly nested behind `cause`); delivery-phase failures
 * carry `result.error` text instead.
 */
function findStatusCode(error: unknown, depth = 0): number | undefined {
  if (error === null || error === undefined || depth > 5) return undefined;
  if (typeof error !== 'object') return undefined;
  const code = (error as { statusCode?: unknown }).statusCode;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? undefined : findStatusCode(cause, depth + 1);
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth++) {
    if (current instanceof Error) parts.push(current.message);
    else if (typeof current === 'string') parts.push(current);
    current =
      typeof current === 'object'
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return parts.join(' | ');
}

/**
 * Recipient-caused failure indicators: the address itself was rejected
 * (bad format, unknown mailbox, 550-class bounce). Guarded against sender
 * mentions — "invalid sender address" is OUR misconfiguration, not the
 * user's typo.
 */
function isRecipientFailure(text: string): boolean {
  if (/sender|from address/i.test(text)) return false;
  return (
    /invalid[\s_-]*(recipient|email|mailbox|address)/i.test(text) ||
    /address[\s_-]*rejected/i.test(text) ||
    /recipient[\s_-]*unknown/i.test(text) ||
    /mailbox[\s_-]*(not[\s_-]*found|unavailable)/i.test(text) ||
    /user[\s_-]*unknown|no[\s_-]*such[\s_-]*user/i.test(text) ||
    /\b55[0-3]\b/.test(text) ||
    /bounce/i.test(text)
  );
}

const TRANSIENT_TEXT_PATTERN =
  /timed?\s*out|timeout|abort|econnreset|etimedout|enotfound|eai_again|econnrefused|epipe|socket hang up|fetch failed|failed to fetch|network/i;

/**
 * OUR failure, not the user's: the sender identity is unverified/misconfigured
 * or the ACS credentials are rejected. A 4xx carrying one of these indicators
 * must never tell the user to "check for typos" — it's our config, not their
 * address.
 */
function isOurFailure(text: string): boolean {
  return /sender|from address|unauthori[sz]ed|forbidden|access key|credential|not verified/i.test(
    text,
  );
}

function classifyAcsError(error: unknown): {
  retryable: boolean;
  failureCode: EmailFailureCode;
} {
  const statusCode = findStatusCode(error);
  if (statusCode !== undefined) {
    // 429 + 5xx: transient — worth retrying.
    if (statusCode === 429 || statusCode >= 500) {
      return { retryable: true, failureCode: 'delivery-failed' };
    }
    // Other 4xx: permanent — never retry. The recipient address comes
    // straight from user input, so a beginSend 400 is the user's typo
    // unless the failure text says it's OURS (sender/config/credentials).
    if (statusCode >= 400) {
      const text = errorText(error);
      return {
        retryable: false,
        failureCode: isOurFailure(text) ? 'delivery-failed' : 'invalid-recipient',
      };
    }
    return { retryable: false, failureCode: 'delivery-failed' };
  }
  // No status code: timeouts, aborts, and network errors are transient.
  if (TRANSIENT_TEXT_PATTERN.test(errorText(error))) {
    return { retryable: true, failureCode: 'delivery-failed' };
  }
  // Unknown: default retryable — retried, never silently dropped as permanent.
  return { retryable: true, failureCode: 'delivery-failed' };
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
          // Permanent misconfiguration — retrying won't help.
          { retryable: false, failureCode: 'delivery-failed' },
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
      // The SDK's pollUntilDone() has no deadline of its own — bound it so
      // a stalled ACS polling endpoint can't hold the HTTP response open
      // forever (2026-09-27: lead-gate "Sending..." hang). Two mechanisms:
      // (1) the abortSignal the SDK honors (core-lro cancels its poll
      // loop), and (2) a Promise.race deadline that guarantees the bound
      // even if the poller ignores the signal.
      //
      // P0 2026-09-27 (triple "estimate is ready" emails): beginSend() above
      // already ACCEPTED the message — ACS owns delivery from here. A
      // polling timeout therefore means "accepted, outcome unknown", NOT
      // "send failed": throwing retryable re-ran beginSend() and duplicated
      // an already-delivered email (deliver() retried twice → 3 emails).
      // So the timeout is non-retryable with sendAccepted: true — the
      // in-code loop never re-sends, and the caller records the
      // accepted-but-unconfirmed send for resubmit suppression. The user
      // still unlocks immediately and sees "check your inbox or try again
      // later" — honest, because the email usually DID arrive.
      const pollTimeoutMs =
        deps.deliveryPollTimeoutMs ?? DEFAULT_DELIVERY_POLL_TIMEOUT_MS;
      const aborter = new AbortController();
      const failTimedOut = (): EmailProviderError => {
        const detail = `delivery polling timed out after ${pollTimeoutMs}ms`;
        logSendFailure('delivery polling timed out (accepted, unconfirmed)', detail);
        // Accepted by ACS, confirmation lost — NEVER retry the send (it
        // would duplicate a delivered email). Non-retryable + sendAccepted
        // so deliver() returns sent:false immediately with
        // acceptedByProvider: true.
        return new EmailProviderError(
          `Azure Communication Services email failed (${detail}).`,
          { retryable: false, failureCode: 'delivery-failed', sendAccepted: true },
        );
      };
      let fireTimeout!: () => void;
      const pollTimer = setTimeout(() => {
        aborter.abort();
        fireTimeout();
      }, pollTimeoutMs);
      // Don't hold the process open on the timer in tests/local runs.
      pollTimer.unref?.();
      try {
        result = await Promise.race([
          poller
            .pollUntilDone({ abortSignal: aborter.signal })
            .catch((error: unknown) => {
              // Our abort won the race: report the timeout, not the SDK's
              // generic abort error.
              if (aborter.signal.aborted) throw failTimedOut();
              throw toProviderError('delivery polling failed', error);
            }),
          new Promise<never>((_, reject) => {
            fireTimeout = () => reject(failTimedOut());
          }),
        ]);
      } finally {
        clearTimeout(pollTimer);
      }
      if (result.status !== 'Succeeded') {
        const detail = result.error?.message
          ? sanitizeErrorText(result.error.message)
          : `status ${result.status}`;
        logSendFailure('not delivered', detail);
        // A bounced/unknown recipient is permanent — never retry a wrong
        // address. Other delivery failures (transient stalls) stay retryable.
        const invalidRecipient = isRecipientFailure(result.error?.message ?? '');
        throw new EmailProviderError(
          `Azure Communication Services email was not delivered (${detail}).`,
          {
            retryable: !invalidRecipient,
            failureCode: invalidRecipient ? 'invalid-recipient' : 'delivery-failed',
          },
        );
      }
      return { provider: 'acs', messageId: result.id };
    },
  };
}
