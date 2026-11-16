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
  ShareLinkCreateResponse,
  ShareLinkListResponse,
  ShareLinkRevokeResponse,
  ShareLinkStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EmailService } from './email';
import { EmailProviderError } from './email';
import { createSandboxSuppressingEmailService } from './email/sandbox-email.service';
import type { LeadStore } from './lead.store';
import { isMagicLinkLive } from './magic-link.service';
import {
  PARTNER_SHARE_LINK_PURPOSE,
  type MagicLinkStore,
} from './magic-link.store';
import { requireOwnerLink, resolveReportToken } from './report-context';
import type { PartnerShareStore } from './partner-share.store';
import type { ShareLinkRecord, ShareLinkStore } from './share-link.store';

/** Request validation — mirrors the contracts `PartnerShareRequest` shape. */
export const PartnerShareRequestSchema = z
  .object({
    reportToken: z.string().min(1),
    partnerEmail: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

/** #838: link-share requests — the owner token is the only input. */
const ShareLinkOwnerRequestSchema = z
  .object({ reportToken: z.string().min(1).max(500) })
  .strict();
const ShareLinkRevokeRequestSchema = z
  .object({
    reportToken: z.string().min(1).max(500),
    shareId: z.string().uuid(),
  })
  .strict();
/** Max link shares returned by the list endpoint. */
const MAX_LISTED_LINKS = 50;

/** CAP-008 abuse control: max partner shares per estimate per day. */
const MAX_SHARES_PER_DAY = 5;
/** Rolling window for the daily share cap, in milliseconds. */
const SHARE_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ShareService {
  /**
   * Share a report with a partner on an untrusted request body. Unknown or
   * expired report tokens → HttpError(404); partner-share tokens (a
   * different token type) → HttpError(403) — only the owner's link can mint
   * new shares. CAP-008 abuse controls: partner email equal to the owner's
   * → HttpError(400); 5+ shares for the estimate in the last 24h →
   * HttpError(429 RATE_LIMITED).
   */
  shareWithPartner(requestBody: unknown): Promise<PartnerShareResponse>;
  /**
   * Verify a partner-share link token. ONLY tokens minted with purpose
   * 'partner-share' redeem here — owner tokens and unknown/expired links
   * are denied with the same invalid/expired shape (no purpose oracle).
   */
  verifyPartnerLink(token: string): Promise<PartnerShareVerifyResponse>;
  /**
   * #838: mint a link-only, read-only, expiring share link for the owner
   * to copy. Owner token only (partner tokens → 403); unknown/expired →
   * 404; more than `maxActive` live links → 429.
   */
  createShareLink(requestBody: unknown): Promise<ShareLinkCreateResponse>;
  /** #838: the owner's link shares with their status (owner token only). */
  listShareLinks(requestBody: unknown): Promise<ShareLinkListResponse>;
  /** #838: revoke one of the owner's link shares (owner token only). */
  revokeShareLink(requestBody: unknown): Promise<ShareLinkRevokeResponse>;
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
  /** #838: link-only shares. Absent = the link endpoints answer 503. */
  readonly shareLinks?: ShareLinkStore;
  /** #838: link-share lifetime (SHARE_LINK_TTL_SECONDS). */
  readonly shareLinkTtlSeconds?: number;
  /** #838: max live link shares per report (SHARE_LINK_MAX_ACTIVE). */
  readonly shareLinkMaxActive?: number;
}

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, fallback: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      parsed.error.issues[0]?.message ?? fallback,
      false,
    );
  }
  return parsed.data;
}

function linkStatus(record: ShareLinkRecord, now: Date): ShareLinkStatus {
  if (record.revokedAt !== null) return 'revoked';
  return record.expiresAt.getTime() > now.getTime() ? 'active' : 'expired';
}

export function createShareService(deps: ShareServiceDeps): ShareService {
  const clock = deps.clock ?? (() => new Date());

  function requireLinkStore(): ShareLinkStore {
    if (!deps.shareLinks) {
      throw new HttpError(
        503,
        ErrorCodes.INTERNAL_ERROR,
        'Share links are not configured.',
      );
    }
    return deps.shareLinks;
  }

  /** Resolve an owner report token (404 unknown/expired, 403 partner). */
  async function ownerLead(reportToken: string) {
    const { lead, linkPurpose } = await resolveReportToken(
      { magicLinks: deps.magicLinks, leads: deps.leads, clock },
      reportToken,
    );
    requireOwnerLink(linkPurpose);
    return lead;
  }

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

      // CAP-008: the partner address must differ from the owner's own —
      // self-sharing would mint a duplicate bearer for the same inbox and
      // is never a legitimate share.
      if (partnerEmail === lead.email.trim().toLowerCase()) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'The partner email must be different from your own email address.',
          false,
        );
      }

      // CAP-008 abuse control: max 5 shares per estimate per day, over a
      // rolling 24-hour window. Share audit rows are lead-scoped and a lead
      // is one estimate thread under the consumer/02 dedupe, so the cap is
      // counted per lead. Checked before any side effect (link mint, email,
      // audit insert) so a denied share leaves no trace.
      const windowStart = new Date(clock().getTime() - SHARE_DAY_WINDOW_MS);
      const recentShares = await deps.shares.countSince(lead.id, windowStart);
      if (recentShares >= MAX_SHARES_PER_DAY) {
        throw new HttpError(
          429,
          ErrorCodes.RATE_LIMITED,
          'You have reached the daily share limit for this report ' +
            '(5 shares per day). Please try again tomorrow.',
        );
      }

      // Fresh link for the partner — the owner's token never leaves the
      // browser and is never stored server-side beyond its hash.
      const issued = await deps.magicLinks.issue({
        leadId: lead.id,
        purpose: PARTNER_SHARE_LINK_PURPOSE,
        ttlSeconds: deps.magicLinkTtlSeconds,
        clock,
        // #840: a sandbox lead's partner link is sandbox test data too, so
        // the sandbox-purge timer removes it with the lead.
        sandbox: lead.sandbox,
      });
      const shareUrl = `${deps.appBaseUrl}/r/${issued.token}`;
      // The email service never throws on send failure — a failed delivery
      // arrives as { sent: false }. Partner share stays fail-loud: a share
      // recorded as sent when the email never went out would be a lie.
      // #840: sandbox (test API key) leads never trigger a real send —
      // route through the no-send decorator.
      const email = lead.sandbox
        ? createSandboxSuppressingEmailService({ inner: deps.email })
        : deps.email;
      const delivery = await email.sendPartnerShare({
        to: partnerEmail,
        ownerName: lead.name,
        shareUrl,
        // Share-link expiry rendered from config, never hardcoded (#186):
        // same derivation as the magic-link callers.
        expiresInDays: Math.max(1, Math.ceil(deps.magicLinkTtlSeconds / 86_400)),
      });
      if (!delivery.sent) {
        throw new EmailProviderError(
          `Partner share email failed: ${delivery.failureReason}`,
          { retryable: false, failureCode: delivery.emailError },
        );
      }

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
      // Only links the share service created redeem: an emailed share's
      // audit row is inserted after the provider accepts the message (a
      // minted-but-never-sent link stays dead); a link-only share (#838)
      // is recorded at creation and has no recipient.
      const audit = await deps.shares.findByMagicLinkId(record.id);
      if (!audit) {
        return { valid: false, reason: 'invalid' };
      }
      const newest = await deps.leads.findNewestEstimateIdByEmailAndAddress({
        email: lead.email,
        addressKey: lead.addressKey,
      });
      const estimateId = newest?.estimateId ?? lead.estimateId;
      return audit.partnerEmail !== null
        ? { valid: true, reportToken: token, estimateId, partnerEmail: audit.partnerEmail }
        : { valid: true, reportToken: token, estimateId };
    },

    async createShareLink(requestBody: unknown): Promise<ShareLinkCreateResponse> {
      const store = requireLinkStore();
      const { reportToken } = parseOrThrow(
        ShareLinkOwnerRequestSchema,
        requestBody,
        'Invalid share link request.',
      );
      const lead = await ownerLead(reportToken);
      const now = clock();
      const maxActive = deps.shareLinkMaxActive ?? 5;
      if ((await store.countActive(lead.id, now)) >= maxActive) {
        throw new HttpError(
          429,
          ErrorCodes.RATE_LIMITED,
          `This report already has ${maxActive} active share links. ` +
            'Turn one off before creating another.',
        );
      }
      // A fresh partner-share link: read-only by token type (owner-only
      // actions refuse it), expiring, and never the owner's own token.
      const issued = await deps.magicLinks.issue({
        leadId: lead.id,
        purpose: PARTNER_SHARE_LINK_PURPOSE,
        ttlSeconds: deps.shareLinkTtlSeconds ?? deps.magicLinkTtlSeconds,
        clock,
        sandbox: lead.sandbox,
      });
      const id = randomUUID();
      await store.insert({ id, leadId: lead.id, magicLinkId: issued.id });
      return {
        id,
        url: `${deps.appBaseUrl}/r/${issued.token}`,
        expiresAt: issued.expiresAt.toISOString(),
      };
    },

    async listShareLinks(requestBody: unknown): Promise<ShareLinkListResponse> {
      const store = requireLinkStore();
      const { reportToken } = parseOrThrow(
        ShareLinkOwnerRequestSchema,
        requestBody,
        'Invalid share link request.',
      );
      const lead = await ownerLead(reportToken);
      const now = clock();
      const rows = await store.listByLeadId(lead.id, MAX_LISTED_LINKS);
      return {
        links: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          status: linkStatus(row, now),
        })),
      };
    },

    async revokeShareLink(requestBody: unknown): Promise<ShareLinkRevokeResponse> {
      const store = requireLinkStore();
      const { reportToken, shareId } = parseOrThrow(
        ShareLinkRevokeRequestSchema,
        requestBody,
        'Invalid revoke request.',
      );
      const lead = await ownerLead(reportToken);
      const revoked = await store.revoke({ shareId, leadId: lead.id, now: clock() });
      if (!revoked) {
        // Unknown id or another lead's share — same answer (no oracle).
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Share link not found.', false);
      }
      return { id: revoked.id, status: 'revoked' };
    },
  };
}
