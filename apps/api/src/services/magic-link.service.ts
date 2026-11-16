/**
 * Magic-link lifecycle (consumer/02).
 *
 * Two public operations:
 *
 * - `verify(token)` — `GET /api/v1/magic-link/verify`. Resolves a bearer
 *   token to the report it unlocks. OWNER links only: a token minted for any
 *   other purpose (e.g. 'partner-share') is answered invalid — partner links
 *   redeem on the dedicated `GET /api/v1/shares/verify` path. The critical
 *   consumer/02 semantic: an OLD token (issued for an earlier estimate on
 *   the same email + property) resolves to the NEWEST estimate, not the one
 *   the token was minted for. `reportToken` is the presented magic token
 *   itself — the future `GET /api/v1/reports/{reportToken}` endpoint will
 *   resolve it the same way (same join), so frontend code can treat the
 *   token as the stable report handle. `usedAt` is NOT set here: it is
 *   reserved for the future verify→reportToken redemption flow and is
 *   ignored by bearer checks (see the magic-link store docs).
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
import { createRateLimiter } from '../middleware/rate-limit';
import {
  createInMemoryCooldown,
  type AnyRateLimiter,
  type SharedCooldown,
} from '../middleware/shared-rate-limit';
import { formatDisplayAddress } from '../lib/display-address';
import { sanitizeErrorMessage } from '../lib/sanitize-error';
import type { EmailDelivery, EmailService } from './email/email.service';
import type { LeadStore } from './lead.store';
import type { UnsubscribeService } from './unsubscribe.service';
import {
  hashMagicToken,
  OWNER_LINK_PURPOSE,
  type IssuedMagicLink,
  type MagicLinkStore,
} from './magic-link.store';

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
  /** Mints the tokenized preference-page URL for the email footer. */
  readonly unsubscribe: UnsubscribeService;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  /**
   * HRD-03: minimum ms between resend emails to the same address, keyed by
   * normalized email. Shared across instances when `reissueCooldown` is
   * wired (#729); otherwise in-memory per instance.
   */
  readonly magicLinkReissueCooldownMs: number;
  /**
   * P1-6 (2026-09-30 security audit): max reissue emails sent to one
   * address per hour — the email-bombing guard the registry always
   * claimed. In-memory per Functions instance, keyed by normalized
   * email — same deliberate scale-out tradeoff as the cooldown above.
   */
  readonly magicLinkMaxSendsPerHour: number;
  /**
   * #729: cross-instance cooldown (Postgres-backed in production) so the
   * one-email-per-address window holds under scale-out. Defaults to the
   * per-instance in-memory cooldown.
   */
  readonly reissueCooldown?: SharedCooldown;
  /**
   * #729: cross-instance hourly send budget keyed by normalized email.
   * Defaults to a per-instance in-memory limiter.
   */
  readonly sendBudget?: AnyRateLimiter;
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
  /** Mints the tokenized preference-page URL for the email footer. */
  readonly unsubscribe: UnsubscribeService;
  readonly leadId: string;
  readonly to: string;
  readonly name?: string;
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  /** #703: the lead's `address_key` — named in the report email. */
  readonly addressKey?: string;
  readonly clock?: () => Date;
}

/**
 * Issue-only half of the consumer/02 issue + email step.
 *
 * Split out so the lead-submit path can degrade gracefully on send
 * failure (Karan directive 2026-09-27): the token is minted before the
 * send, so a failed send must not lose the token — the request can still
 * return 200 with the report unlocked and `magicLinkSent: false`.
 */
export async function issueOwnerMagicLinkToken(args: {
  readonly magicLinks: MagicLinkStore;
  readonly leadId: string;
  readonly magicLinkTtlSeconds: number;
  readonly clock?: () => Date;
  /** #793: flag the link row for the sandbox purge. */
  readonly sandbox?: boolean;
}): Promise<IssuedMagicLink> {
  return args.magicLinks.issue({
    leadId: args.leadId,
    purpose: OWNER_LINK_PURPOSE,
    ttlSeconds: args.magicLinkTtlSeconds,
    clock: args.clock,
    ...(args.sandbox ? { sandbox: true } : {}),
  });
}

export interface SendOwnerMagicLinkEmailArgs {
  readonly email: EmailService;
  /** Mints the tokenized preference-page URL for the email footer. */
  readonly unsubscribe: UnsubscribeService;
  readonly leadId: string;
  readonly to: string;
  readonly name?: string;
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  readonly token: string;
  /** #703: the lead's `address_key` — named (display-formatted) in the email. */
  readonly addressKey?: string;
  /** #703: the issued token's `expires_at` — the email states this date. */
  readonly expiresAt?: Date;
}

/**
 * Send-only half of the consumer/02 issue + email step.
 *
 * Never throws on send failure — returns the EmailDelivery (the email
 * service retries retryable failures in-code; exhaustion yields
 * `{ sent: false, ... }`). Callers that must not fail the request map
 * `sent: false` to their degraded UX (lead submit: 200 +
 * `magicLinkSent: false` + `emailError` reason code).
 */
export async function sendOwnerMagicLinkEmail(
  args: SendOwnerMagicLinkEmailArgs,
): Promise<EmailDelivery> {
  // The footer URL is best-effort: if minting fails (e.g. the unsubscribe
  // secret is unconfigured), the magic link must still send — a missing
  // footer is better than a missing estimate link.
  let unsubscribeUrl: string | undefined;
  try {
    unsubscribeUrl = args.unsubscribe.buildUnsubscribeUrl(args.leadId);
  } catch (error) {
    console.error(
      `magic-link: unsubscribe URL mint failed (${sanitizeErrorMessage(error)})`,
    );
  }
  return args.email.sendMagicLink({
    to: args.to,
    name: args.name,
    magicLinkUrl: `${args.appBaseUrl}/r/${args.token}`,
    expiresInDays: Math.max(1, Math.ceil(args.magicLinkTtlSeconds / 86_400)),
    audience: 'consumer',
    unsubscribeUrl,
    ...(args.addressKey ? { address: formatDisplayAddress(args.addressKey) } : {}),
    ...(args.expiresAt ? { expiresOn: args.expiresAt } : {}),
  });
}

export async function issueAndSendMagicLink(
  args: IssueAndSendMagicLinkArgs,
): Promise<EmailDelivery> {
  const issued = await issueOwnerMagicLinkToken(args);
  return sendOwnerMagicLinkEmail({
    ...args,
    token: issued.token,
    expiresAt: issued.expiresAt,
  });
}

/** P1-6: the per-email send budget is hourly (registry: "/hr per email"). */
export const MAGIC_LINK_SEND_BUDGET_WINDOW_MS = 3_600_000;

export function createMagicLinkService(
  deps: MagicLinkServiceDeps,
): MagicLinkService {
  const {
    magicLinks,
    leads,
    email,
    unsubscribe,
    appBaseUrl,
    magicLinkTtlSeconds,
    magicLinkReissueCooldownMs,
    magicLinkMaxSendsPerHour,
    clock = () => new Date(),
  } = deps;

  /**
   * HRD-03: per-email resend cooldown, started by each email this service
   * sends on the reissue path (shared across instances, #729). The live-link
   * check above already blocks the common rapid-resend case (a fresh send
   * mints a live link); this covers the residual case where no live link
   * exists but an email went out recently (revoked link, clock skew between
   * the send and the store write). Denials answer `{ sent: false }` —
   * identical to the live-link and unknown-email cases — so the endpoint
   * can't be used as a send oracle.
   */
  const reissueCooldown: SharedCooldown =
    deps.reissueCooldown ??
    createInMemoryCooldown(magicLinkReissueCooldownMs, () => clock().getTime());

  /**
   * P1-6: hourly per-email send budget (fixed window, shared rate-limiter
   * primitive). Checked only on the genuine send path — after the
   * unknown-email, live-link, and cooldown short-circuits — so hammering
   * an unknown address can never burn (or reveal) a budget. Exhaustion
   * answers `{ sent: false }`, identical to every other non-send outcome.
   */
  const sendBudget: AnyRateLimiter =
    deps.sendBudget ??
    createRateLimiter({
      windowMs: MAGIC_LINK_SEND_BUDGET_WINDOW_MS,
      maxRequests: magicLinkMaxSendsPerHour,
      maxTrackedKeys: 10_000,
      clock: () => clock().getTime(),
    });

  return {
    async verify(token: string): Promise<MagicLinkVerifyResponse> {
      const record = await magicLinks.findByToken(token);
      if (!record || record.leadId === null) {
        return { valid: false, reason: 'invalid', reissueAllowed: true };
      }
      if (record.purpose !== OWNER_LINK_PURPOSE) {
        // Partner-share (and any future non-owner) tokens are a DIFFERENT
        // token type: they never verify as owner links. Same denial shape
        // as an invalid token — no purpose oracle.
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
        .filter((l) => l.purpose === OWNER_LINK_PURPOSE)
        .some((l) => isMagicLinkLive(l, now));
      if (live) {
        // AC4: a repeat/reissue with a live link sends nothing.
        return { sent: false };
      }
      // HRD-03: per-email resend cooldown. Same `{ sent: false }` shape as
      // every other non-send outcome — no timing oracle for attackers.
      if (await reissueCooldown.isActive(lead.email)) {
        return { sent: false };
      }
      // P1-6: hourly per-email send budget — the email-bombing guard.
      // Same `{ sent: false }` shape as every other non-send outcome.
      if (!(await sendBudget.check(lead.email)).allowed) {
        return { sent: false };
      }
      const delivery = await issueAndSendMagicLink({
        magicLinks,
        email,
        unsubscribe,
        leadId: lead.id,
        to: lead.email,
        name: lead.name,
        appBaseUrl,
        magicLinkTtlSeconds,
        addressKey: lead.addressKey,
        clock,
      });
      // Only a delivered resend starts the cooldown — a failed send leaves
      // the window open so the user can retry immediately.
      if (delivery.sent) await reissueCooldown.start(lead.email);
      return { sent: delivery.sent };
    },
  };
}

/** Re-exported for tests that assert the stored hash (never the raw token). */
export { hashMagicToken };
