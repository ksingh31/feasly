/**
 * Magic-link lifecycle (consumer/02).
 *
 * Two public operations:
 *
 * - `verify(token)` — `GET /api/v1/magic-link/verify`. Resolves a bearer
 *   token to the report it unlocks. The critical consumer/02 semantic: an
 *   OLD token (issued for an earlier estimate on the same email + property)
 *   resolves to the NEWEST estimate, not the one the token was minted for.
 *   `reportToken` is the presented magic token itself — the future
 *   `GET /api/v1/reports/{reportToken}` endpoint will resolve it the same
 *   way (same join), so frontend code can treat the token as the stable
 *   report handle. `usedAt` is NOT set here: it is reserved for the
 *   future verify→reportToken redemption flow and is ignored by bearer
 *   checks (see the magic-link store docs).
 *
 * - `reissue({ email })` — `POST /api/v1/magic-link/reissue`. Idempotent
 *   "resend my link". A live link is never re-sent (no duplicate emails);
 *   an expired or missing link is reissued and emailed. Unknown emails
 *   return `{ sent: false }` without revealing whether the address exists.
 *
 * Neither operation logs tokens or emails (PII discipline).
 */
import type {
  MagicLinkReissueResponse,
  MagicLinkVerifyResponse,
} from '@feasly/contracts';
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EmailService } from './email/email.service';
import type { LeadStore } from './lead.store';
import { hashMagicToken, type MagicLinkStore } from './magic-link.store';

export interface MagicLinkService {
  /** Resolve a bearer token to the report it unlocks. */
  verify(token: string): Promise<MagicLinkVerifyResponse>;
  /** Idempotent resend: issues + emails a link only when none is live. */
  reissue(request: unknown): Promise<MagicLinkReissueResponse>;
}

export interface MagicLinkServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly email: EmailService;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  /**
   * HRD-03: minimum ms between resend emails to the same address. In-memory
   * per Functions instance, keyed by normalized email — same deliberate
   * scale-out tradeoff as the pipeline rate limiters.
   */
  readonly magicLinkReissueCooldownMs: number;
  readonly clock?: () => Date;
}

const reissueRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

/**
 * A stored link row is "live" when it has not been revoked, has not
 * expired, and (per the store's bearer semantics) regardless of `usedAt`.
 * Exported so the lead service's dedupe path applies the identical rule.
 */
export function isMagicLinkLive(
  record: { readonly revokedAt: Date | null; readonly expiresAt: Date },
  now: Date,
): boolean {
  return record.revokedAt === null && record.expiresAt.getTime() > now.getTime();
}

/**
 * Shared issue + email step (consumer/02).
 *
 * Used by the lead service (new capture and expired-link reissue on the
 * dedupe path) and by `MagicLinkService.reissue` — one place that mints
 * the URL and calls the email provider, so the "no duplicate emails"
 * rule can't drift between call sites. The raw token is never stored or
 * logged; only the email carries it.
 */
export interface IssueAndSendMagicLinkArgs {
  readonly magicLinks: MagicLinkStore;
  readonly email: EmailService;
  readonly leadId: string;
  readonly to: string;
  readonly name?: string;
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  readonly clock?: () => Date;
}

export async function issueAndSendMagicLink(
  args: IssueAndSendMagicLinkArgs,
): Promise<void> {
  const issued = await args.magicLinks.issue({
    leadId: args.leadId,
    purpose: 'lead',
    ttlSeconds: args.magicLinkTtlSeconds,
    clock: args.clock,
  });
  await args.email.sendMagicLink({
    to: args.to,
    name: args.name,
    magicLinkUrl: `${args.appBaseUrl}/r/${issued.token}`,
    expiresInDays: Math.max(1, Math.ceil(args.magicLinkTtlSeconds / 86_400)),
    audience: 'consumer',
  });
}

export function createMagicLinkService(
  deps: MagicLinkServiceDeps,
): MagicLinkService {
  const {
    magicLinks,
    leads,
    email,
    appBaseUrl,
    magicLinkTtlSeconds,
    magicLinkReissueCooldownMs,
    clock = () => new Date(),
  } = deps;

  /**
   * HRD-03: per-email resend cooldown. Maps normalized email → ms timestamp
   * of the last email this service sent on the reissue path. The live-link
   * check above already blocks the common rapid-resend case (a fresh send
   * mints a live link); this covers the residual case where no live link
   * exists but an email went out recently (revoked link, clock skew between
   * the send and the store write). Denials answer `{ sent: false }` —
   * identical to the live-link and unknown-email cases — so the endpoint
   * can't be used as a send oracle.
   */
  const lastResendAtMs = new Map<string, number>();

  return {
    async verify(token: string): Promise<MagicLinkVerifyResponse> {
      const record = await magicLinks.findByToken(token);
      if (!record || record.leadId === null) {
        return { valid: false, reason: 'invalid', reissueAllowed: true };
      }
      const lead = await leads.findById(record.leadId);
      if (!lead) {
        // Lead erased after the link was minted: the token can never work.
        return { valid: false, reason: 'invalid', reissueAllowed: true };
      }
      if (!isMagicLinkLive(record, clock())) {
        return {
          valid: false,
          reason: 'expired',
          reissueAllowed: !lead.quarantined,
        };
      }
      // Old links resolve to the NEWEST estimate for this email + property
      // (consumer/02 AC2). Falls back to the link's own estimate if the
      // household has no estimates left (erasure raced the verify).
      const newest = await leads.findNewestEstimateIdByEmailAndAddress({
        email: lead.email,
        addressKey: lead.addressKey,
      });
      return {
        valid: true,
        reportToken: token,
        estimateId: newest?.estimateId ?? lead.estimateId,
        leadId: lead.id,
      };
    },

    async reissue(request: unknown): Promise<MagicLinkReissueResponse> {
      const parsed = reissueRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A valid email address is required.',
          false,
        );
      }
      const household = await leads.findAllByEmail(parsed.data.email);
      const lead =
        household.length > 0
          ? household.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
          : null;
      if (!lead || lead.quarantined) {
        // Unknown email: identical response, no oracle. Quarantined: no mail.
        return { sent: false };
      }
      const now = clock();
      const links = await magicLinks.findByLeadIds([lead.id]);
      const live = links
        .filter((l) => l.purpose === 'lead')
        .some((l) => isMagicLinkLive(l, now));
      if (live) {
        // AC4: a repeat/reissue with a live link sends nothing.
        return { sent: false };
      }
      // HRD-03: per-email resend cooldown. Same `{ sent: false }` shape as
      // every other non-send outcome — no timing oracle for attackers.
      const nowMs = now.getTime();
      const lastSent = lastResendAtMs.get(lead.email);
      if (lastSent !== undefined && nowMs - lastSent < magicLinkReissueCooldownMs) {
        return { sent: false };
      }
      await issueAndSendMagicLink({
        magicLinks,
        email,
        leadId: lead.id,
        to: lead.email,
        name: lead.name,
        appBaseUrl,
        magicLinkTtlSeconds,
        clock,
      });
      lastResendAtMs.set(lead.email, nowMs);
      return { sent: true };
    },
  };
}

/** Re-exported for tests that assert the stored hash (never the raw token). */
export { hashMagicToken };
