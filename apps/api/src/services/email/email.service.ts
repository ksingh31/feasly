/**
 * The one email service (story email/01).
 *
 * Every send path in the product funnels through here — magic-link
 * (consumer + admin + reissue), partner-share (fresh bearer token per share,
 * NEVER the owner's magic link forwarded), callback confirmation to the team
 * inbox, the 24-hour nudge, and ops alerts. No per-endpoint email hacks.
 *
 * The service itself never logs PII: providers handle their own logging
 * discipline (the log provider redacts recipients unless EMAIL_LOG_LINKS).
 * Unsubscribe: non-transactional templates (nudge) get one-click
 * unsubscribe via UNSUBSCRIBE_URL_BASE + List-Unsubscribe headers. The real
 * unsubscribe center (review-drafts/05) isn't built yet — the base URL is a
 * placeholder hook it fills later.
 */
import type {
  EmailMessage,
  EmailProvider,
} from './email.types';
import { EmailProviderError, type EmailFailureCode } from './email.types';
import { sanitizeErrorMessage } from '../../lib/sanitize-error';
import {
  renderCallbackTeamEmail,
  renderCommissionInvoiceReadyEmail,
  renderCommissionPaymentFailedEmail,
  renderCommissionPaymentReceivedEmail,
  renderInvitationEmail,
  renderMagicLinkEmail,
  renderNudgeEmail,
  renderOpsAlertEmail,
  renderShareEmail,
  type TemplateContext,
} from './templates';

export interface MagicLinkEmailInput {
  readonly to: string;
  readonly name?: string;
  /** Fully-formed single-use magic-link URL, minted by the caller (BE-5). */
  readonly magicLinkUrl: string;
  /** Days until expiry — rendered from config, never hardcoded. */
  readonly expiresInDays: number;
  readonly audience: 'consumer' | 'admin' | 'builder';
  /**
   * Tokenized preference-page URL, minted by the caller via
   * UnsubscribeService.buildUnsubscribeUrl. Rendered as the unsubscribe
   * footer for the consumer audience only; absent for admin/builder.
   */
  readonly unsubscribeUrl?: string;
}

export interface PartnerShareEmailInput {
  readonly to: string;
  readonly partnerName?: string;
  readonly ownerName?: string;
  /**
   * Fresh single-use bearer share URL minted for THIS partner. The caller's
   * contract: never pass the owner's magic link here.
   */
  readonly shareUrl: string;
  readonly note?: string;
  /** Days until the share link expires — rendered from config, never hardcoded. */
  readonly expiresInDays: number;
}

export interface CallbackConfirmationInput {
  readonly leadName: string;
  readonly leadEmail: string;
  readonly leadPhone?: string;
  readonly timeline?: string;
  readonly estimateId: string;
  readonly requestedAt: Date;
  /** Overrides the configured ops inbox (tests). */
  readonly teamInbox?: string;
}

export interface NudgeEmailInput {
  readonly to: string;
  readonly name?: string;
  readonly resumeUrl: string;
  /**
   * Full one-click unsubscribe URL (token embedded). Minted by
   * UnsubscribeService.buildUnsubscribeUrl — the email service never mints
   * or parses tokens itself.
   */
  readonly unsubscribeUrl: string;
}

export interface OpsAlertEmailInput {
  readonly to: string;
  readonly title: string;
  readonly summary: string;
  readonly detailsUrl?: string;
  readonly firedAt: Date;
}

export interface InvitationEmailInput {
  readonly to: string;
  readonly name?: string;
  /**
   * Sign-in URL (e.g. /admin/login) — Entra External ID owns the
   * credential, so the email carries no token and no password.
   */
  readonly signInUrl: string;
  /** Days until the invitation expires — rendered from config, never hardcoded. */
  readonly expiresInDays: number;
  /** Human-readable access grant, e.g. "an admin" or "a team member for Elite Craft Builders". */
  readonly accessDescription: string;
  /** Name of the person who sent the invite, if known. */
  readonly inviterName?: string;
}

/**
 * BILL-04 inputs. Transactional account-billing mail — always sent, no
 * unsubscribe footer (the builder is being charged real money; these are
 * account notices, not marketing).
 */
export interface CommissionInvoiceReadyEmailInput {
  readonly to: string;
  /** Public invoice reference shown to the builder (short id). */
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly contractValueCents: number;
  readonly currency: string;
  /** Effective commission rate applied to the invoice, in PERCENT. */
  readonly commissionRatePercent: number;
  /** End of the 7-day review window. */
  readonly reviewDueAt: Date;
}

export interface CommissionPaymentReceivedEmailInput {
  readonly to: string;
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly currency: string;
  readonly paidAt: Date;
}

export interface CommissionPaymentFailedEmailInput {
  readonly to: string;
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly currency: string;
  /** Days the builder has to update the card before collection steps. */
  readonly updateWithinDays: number;
}

export interface EmailService {
  sendMagicLink(input: MagicLinkEmailInput): Promise<EmailDelivery>;
  sendInvitation(input: InvitationEmailInput): Promise<EmailDelivery>;
  sendPartnerShare(input: PartnerShareEmailInput): Promise<EmailDelivery>;
  sendCallbackConfirmation(
    input: CallbackConfirmationInput,
  ): Promise<EmailDelivery>;
  sendNudge(input: NudgeEmailInput): Promise<EmailDelivery>;
  sendOpsAlert(input: OpsAlertEmailInput): Promise<EmailDelivery>;
  /** BILL-04: invoice entered the 7-day review window. */
  sendCommissionInvoiceReady(
    input: CommissionInvoiceReadyEmailInput,
  ): Promise<EmailDelivery>;
  /** BILL-04: off-session charge succeeded (receipt). */
  sendCommissionPaymentReceived(
    input: CommissionPaymentReceivedEmailInput,
  ): Promise<EmailDelivery>;
  /** BILL-04: off-session charge failed (update-card CTA). */
  sendCommissionPaymentFailed(
    input: CommissionPaymentFailedEmailInput,
  ): Promise<EmailDelivery>;
}

export interface EmailServiceDeps {
  readonly provider: EmailProvider;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly appBaseUrl: string;
  readonly unsubscribeBaseUrl: string;
  /** Team inbox for callback confirmations + default ops-alert target. */
  readonly opsInbox: string;
  /**
   * Max send attempts (initial try + retries). Default 3 (Karan 2026-09-27:
   * at least 2 retries). From EMAIL_SEND_MAX_ATTEMPTS.
   */
  readonly maxAttempts?: number;
  /** Backoff between attempts, ms. Default 1000. */
  readonly retryBackoffMs?: number;
}

/**
 * What every EmailService send method resolves with — the service never
 * throws on send failure. `deliver()` retries retryable failures inside;
 * when attempts are exhausted (or the failure is permanent) the failure is
 * returned so callers can degrade gracefully (lead gate: 200 +
 * `magicLinkSent: false` + reportToken, report still unlocks).
 */
export type EmailDelivery =
  | {
      readonly sent: true;
      readonly provider: EmailProvider['name'];
      readonly messageId?: string;
    }
  | {
      readonly sent: false;
      readonly provider: EmailProvider['name'];
      /** Sanitized one-line failure summary — logs only, never shown to users. */
      readonly failureReason: string;
      /**
       * UX reason code. 'invalid-recipient': the address was rejected — tell
       * the user to check for typos (it will never arrive). 'delivery-failed':
       * transient failure after retries — an earlier attempt may still have
       * sent it, so "check your inbox or try again later" is honest.
       */
      readonly emailError: EmailFailureCode;
      /**
       * True when the provider accepted the message but delivery couldn't
       * be confirmed (ACS beginSend succeeded, polling timed out). The send
       * was NOT retried — re-sending would likely duplicate a delivered
       * email (P0 2026-09-27). Callers should record this like a send for
       * resubmit suppression: a user retry must not start a second send.
       */
      readonly acceptedByProvider?: boolean;
    };

/** Default max attempts: initial try + 2 retries. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Default backoff between attempts. */
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEmailService(deps: EmailServiceDeps): EmailService {
  const ctx: TemplateContext = {
    appBaseUrl: deps.appBaseUrl,
    unsubscribeBaseUrl: deps.unsubscribeBaseUrl,
    brandName: 'Feasly',
  };

  /**
   * The one funnel every send path goes through. Retries retryable
   * failures (provider-classified: timeouts, 429, 5xx, network errors)
   * with a short backoff; permanent failures (wrong address, rejected
   * sender) skip retries and go straight to the failure result. Never
   * throws on send failure — exhaustion returns `{ sent: false, ... }`
   * so callers degrade gracefully instead of 500ing.
   *
   * Duplicate-email safety (P0 2026-09-27): a retry NEVER re-sends a
   * message the provider already accepted. Providers signal that with
   * `EmailProviderError.sendAccepted` (ACS: beginSend succeeded, delivery
   * polling timed out) — such errors are never retried, and the returned
   * failure carries `acceptedByProvider: true` so callers can suppress
   * resubmits. Retries only re-attempt sends that never reached the
   * provider, where a duplicate is impossible.
   */
  async function deliver(message: EmailMessage): Promise<EmailDelivery> {
    const maxAttempts = Math.max(
      1,
      Math.floor(deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    );
    const backoffMs = Math.max(0, deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const result = await deps.provider.send(message);
        return {
          sent: true,
          provider: result.provider,
          messageId: result.messageId,
        };
      } catch (error) {
        // Classification lives with the provider (EmailProviderError):
        // unknown/non-provider errors default to retryable — retried, never
        // silently dropped as permanent.
        const retryable =
          error instanceof EmailProviderError ? error.retryable : true;
        const emailError: EmailFailureCode =
          error instanceof EmailProviderError
            ? error.failureCode
            : 'delivery-failed';
        if (retryable && attempt < maxAttempts) {
          await sleep(backoffMs);
          continue;
        }
        return {
          sent: false,
          provider: deps.provider.name,
          failureReason: sanitizeErrorMessage(error),
          emailError,
          // Accepted-but-unconfirmed: the provider has the message (a
          // re-send would likely duplicate it), so this failure is never
          // retried and the caller must suppress resubmits.
          ...(error instanceof EmailProviderError && error.sendAccepted
            ? { acceptedByProvider: true as const }
            : {}),
        };
      }
    }
  }

  return {
    async sendMagicLink(input: MagicLinkEmailInput): Promise<EmailDelivery> {
      const rendered = renderMagicLinkEmail(ctx, input);
      return deliver({ ...rendered, to: input.to });
    },

    async sendInvitation(input: InvitationEmailInput): Promise<EmailDelivery> {
      const rendered = renderInvitationEmail(ctx, input);
      return deliver({ ...rendered, to: input.to });
    },

    async sendPartnerShare(
      input: PartnerShareEmailInput,
    ): Promise<EmailDelivery> {
      const rendered = renderShareEmail(ctx, input);
      return deliver({ ...rendered, to: input.to });
    },

    async sendCallbackConfirmation(
      input: CallbackConfirmationInput,
    ): Promise<EmailDelivery> {
      const rendered = renderCallbackTeamEmail(ctx, {
        leadName: input.leadName,
        leadEmail: input.leadEmail,
        leadPhone: input.leadPhone,
        timeline: input.timeline,
        estimateId: input.estimateId,
        requestedAt: input.requestedAt,
      });
      return deliver({ ...rendered, to: input.teamInbox ?? deps.opsInbox });
    },

    async sendNudge(input: NudgeEmailInput): Promise<EmailDelivery> {
      const rendered = renderNudgeEmail(ctx, {
        name: input.name,
        resumeUrl: input.resumeUrl,
        unsubscribeUrl: input.unsubscribeUrl,
      });
      return deliver({
        ...rendered,
        to: input.to,
        headers: {
          'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
    },

    async sendOpsAlert(input: OpsAlertEmailInput): Promise<EmailDelivery> {
      const rendered = renderOpsAlertEmail(ctx, {
        title: input.title,
        summary: input.summary,
        detailsUrl: input.detailsUrl,
        firedAt: input.firedAt,
      });
      return deliver({ ...rendered, to: input.to });
    },

    async sendCommissionInvoiceReady(
      input: CommissionInvoiceReadyEmailInput,
    ): Promise<EmailDelivery> {
      const rendered = renderCommissionInvoiceReadyEmail(ctx, {
        invoiceRef: input.invoiceRef,
        commissionCents: input.commissionCents,
        contractValueCents: input.contractValueCents,
        currency: input.currency,
        commissionRatePercent: input.commissionRatePercent,
        reviewDueAt: input.reviewDueAt,
      });
      return deliver({ ...rendered, to: input.to });
    },

    async sendCommissionPaymentReceived(
      input: CommissionPaymentReceivedEmailInput,
    ): Promise<EmailDelivery> {
      const rendered = renderCommissionPaymentReceivedEmail(ctx, {
        invoiceRef: input.invoiceRef,
        commissionCents: input.commissionCents,
        currency: input.currency,
        paidAt: input.paidAt,
      });
      return deliver({ ...rendered, to: input.to });
    },

    async sendCommissionPaymentFailed(
      input: CommissionPaymentFailedEmailInput,
    ): Promise<EmailDelivery> {
      const rendered = renderCommissionPaymentFailedEmail(ctx, {
        invoiceRef: input.invoiceRef,
        commissionCents: input.commissionCents,
        currency: input.currency,
        updateWithinDays: input.updateWithinDays,
      });
      return deliver({ ...rendered, to: input.to });
    },
  };
}
