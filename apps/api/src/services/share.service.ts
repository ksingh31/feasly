/**
 * Email-to-partner report sharing (phase-2 wiring).
 *
 * The report page's "email to partner" flow: validates the contract shape,
 * resolves the owner's report token to its lead (unknown/expired → 404),
 * mints a FRESH magic link (purpose 'partner-share', attached to the same
 * lead — the owner's token is never persisted or reused, and the partner's
 * link is only ever sent to the verified recipient address), emails it,
 * and records the audit row.
 *
 * Delivery note: `sent` reflects the configured email provider's
 * acceptance. Until the Azure Communication Services sender is provisioned
 * the provider is the log channel, so `sent: true` means "accepted and
 * logged", not "delivered to an inbox" — flagged as a placeholder for
 * Karan's sender-domain decision.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PartnerShareResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EmailService } from './email';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import { resolveReportToken } from './report-context';
import type { PartnerShareStore } from './partner-share.store';

/** Request validation — mirrors the contracts `PartnerShareRequest` shape. */
export const PartnerShareRequestSchema = z
  .object({
    reportToken: z.string().min(1),
    partnerEmail: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export interface ShareService {
  /**
   * Share a report with a partner on an untrusted request body. Unknown or
   * expired report tokens → HttpError(404).
   */
  shareWithPartner(requestBody: unknown): Promise<PartnerShareResponse>;
}

export interface ShareServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly shares: PartnerShareStore;
  readonly email: EmailService;
  /** Public web origin used to build the partner's report URL. */
  readonly appBaseUrl: string;
  /** TTL for the partner's magic link, in seconds. */
  readonly magicLinkTtlSeconds: number;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

export function createShareService(deps: ShareServiceDeps): ShareService {
  const clock = deps.clock ?? (() => new Date());
  return {
    async shareWithPartner(requestBody: unknown): Promise<PartnerShareResponse> {
      const parsed = PartnerShareRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          parsed.error.issues[0]?.message ?? 'Invalid share request.',
          false,
        );
      }
      const { reportToken, partnerEmail } = parsed.data;
      const { lead } = await resolveReportToken(
        { magicLinks: deps.magicLinks, leads: deps.leads, clock },
        reportToken,
      );

      // Fresh link for the partner — the owner's token never leaves the
      // browser and is never stored server-side beyond its hash.
      const issued = await deps.magicLinks.issue({
        leadId: lead.id,
        purpose: 'partner-share',
        ttlSeconds: deps.magicLinkTtlSeconds,
        clock,
      });
      const shareUrl = `${deps.appBaseUrl}/r/${issued.token}`;
      // The provider either accepts the message (resolves) or throws. Until
      // the ACS sender is provisioned the log channel accepts everything.
      await deps.email.sendPartnerShare({
        to: partnerEmail,
        ownerName: lead.name,
        shareUrl,
      });

      await deps.shares.insert({
        id: randomUUID(),
        leadId: lead.id,
        magicLinkId: issued.id,
        partnerEmail,
        sent: true,
      });
      return { sent: true, sharedTo: partnerEmail };
    },
  };
}
