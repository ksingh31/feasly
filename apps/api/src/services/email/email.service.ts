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
  EmailSendResult,
} from './email.types';
import {
  renderCallbackTeamEmail,
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

export interface EmailService {
  sendMagicLink(input: MagicLinkEmailInput): Promise<EmailSendResult>;
  sendPartnerShare(input: PartnerShareEmailInput): Promise<EmailSendResult>;
  sendCallbackConfirmation(
    input: CallbackConfirmationInput,
  ): Promise<EmailSendResult>;
  sendNudge(input: NudgeEmailInput): Promise<EmailSendResult>;
  sendOpsAlert(input: OpsAlertEmailInput): Promise<EmailSendResult>;
}

export interface EmailServiceDeps {
  readonly provider: EmailProvider;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly appBaseUrl: string;
  readonly unsubscribeBaseUrl: string;
  /** Team inbox for callback confirmations + default ops-alert target. */
  readonly opsInbox: string;
}

export function createEmailService(deps: EmailServiceDeps): EmailService {
  const ctx: TemplateContext = {
    appBaseUrl: deps.appBaseUrl,
    unsubscribeBaseUrl: deps.unsubscribeBaseUrl,
    brandName: 'Feasly',
  };

  async function deliver(message: EmailMessage): Promise<EmailSendResult> {
    return deps.provider.send(message);
  }

  return {
    async sendMagicLink(input: MagicLinkEmailInput): Promise<EmailSendResult> {
      const rendered = renderMagicLinkEmail(ctx, input);
      return deliver({ ...rendered, to: input.to });
    },

    async sendPartnerShare(
      input: PartnerShareEmailInput,
    ): Promise<EmailSendResult> {
      const rendered = renderShareEmail(ctx, input);
      return deliver({ ...rendered, to: input.to });
    },

    async sendCallbackConfirmation(
      input: CallbackConfirmationInput,
    ): Promise<EmailSendResult> {
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

    async sendNudge(input: NudgeEmailInput): Promise<EmailSendResult> {
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

    async sendOpsAlert(input: OpsAlertEmailInput): Promise<EmailSendResult> {
      const rendered = renderOpsAlertEmail(ctx, {
        title: input.title,
        summary: input.summary,
        detailsUrl: input.detailsUrl,
        firedAt: input.firedAt,
      });
      return deliver({ ...rendered, to: input.to });
    },
  };
}
