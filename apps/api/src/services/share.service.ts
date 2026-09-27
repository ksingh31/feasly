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
import type {
  PartnerShareResponse,
  PartnerShareVerifyResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EmailService } from './email';
import type { LeadStore } from './lead.store';
import { isMagicLinkLive } from './magic-link.service';
import {
  PARTNER_SHARE_LINK_PURPOSE,
  type MagicLinkStore,
} from './magic-link.store';
import { requireOwnerLink, resolveReportToken } from './report-context';
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
   * expired report tokens → HttpError(404); partner-share tokens (a
   * different token type) → HttpError(403) — only the owner's link can mint
   * new shares.
   */
  shareWithPartner(requestBody: unknown): Promise<PartnerShareResponse>;
  /**
   * Verify a partner-share link token. ONLY tokens minted with purpose
   * 'partner-share' redeem here — owner tokens and unknown/expired links
   * are denied with the same invalid/expired shape (no purpose oracle).
   */
  verifyPartnerLink(token: string): Promise<PartnerShareVerifyResponse>;
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
      const { lead, linkPurpose } = await resolveReportToken(
        { magicLinks: deps.magicLinks, leads: deps.leads, clock },
        reportToken,
      );
      // Only the owner's link mints new shares: a partner link is a
      // different token type and must not fan out more links.
      requireOwnerLink(linkPurpose);

      // Fresh link for the partner — the owner's token never leaves the
      // browser and is never stored server-side beyond its hash.
      const issued = await deps.magicLinks.issue({
        leadId: lead.id,
        purpose: PARTNER_SHARE_LINK_PURPOSE,
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
        // Share-link expiry rendered from config, never hardcoded (#186):
        // same derivation as the magic-link callers.
        expiresInDays: Math.max(1, Math.ceil(deps.magicLinkTtlSeconds / 86_400)),
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

    /**
     * Partner-link redemption for `/r/:token`.
     *
     * Mirrors the owner magic-link verify semantics (consumer/02): unknown
     * token, missing lead, or a link that was never emailed → invalid;
     * revoked or expired → expired; an old link resolves to the NEWEST
     * estimate for the email + property. The `valid: false` shapes are
     * deliberately identical for owner tokens presented here — the caller
     * learns nothing about which token types exist.
     */
    async verifyPartnerLink(token: string): Promise<PartnerShareVerifyResponse> {
      if (typeof token !== 'string' || token.length === 0) {
        return { valid: false, reason: 'invalid' };
      }
      const record = await deps.magicLinks.findByToken(token);
      if (
        !record ||
        record.leadId === null ||
        record.purpose !== PARTNER_SHARE_LINK_PURPOSE
      ) {
        return { valid: false, reason: 'invalid' };
      }
      const lead = await deps.leads.findById(record.leadId);
      if (!lead) {
        return { valid: false, reason: 'invalid' };
      }
      if (!isMagicLinkLive(record, clock())) {
        return { valid: false, reason: 'expired' };
      }
      // Only links the share service actually emailed redeem: the audit
      // row is inserted after the provider accepts the message, so a
      // minted-but-never-sent link stays dead.
      const audit = await deps.shares.findByMagicLinkId(record.id);
      if (!audit) {
        return { valid: false, reason: 'invalid' };
      }
      const newest = await deps.leads.findNewestEstimateIdByEmailAndAddress({
        email: lead.email,
        addressKey: lead.addressKey,
      });
      return {
        valid: true,
        reportToken: token,
        estimateId: newest?.estimateId ?? lead.estimateId,
        partnerEmail: audit.partnerEmail,
      };
    },
  };
}
