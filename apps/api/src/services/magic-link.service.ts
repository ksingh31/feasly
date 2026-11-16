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
 * - `listEstimates(token)` — `GET /api/v1/magic-link/estimates` (#800).
 *   A HOUSEHOLD link (reissue-minted, delivered only by email) lists the
 *   email's most recent estimates, one per property, newest first. Any other
 *   live owner link lists only its own report — lead-submit tokens are handed
 *   to whoever typed the email, so they must not reveal the household's
 *   other addresses.
 *
 * - `openEstimate({ token, handle })` — `POST /api/v1/magic-link/estimates/open`
 *   (#800). Mints a plain (non-household) per-lead owner link for one list
 *   item — including the household token's own property — capped to the
 *   household token's own expiry (opening never extends access). Other
 *   leads' tokens are never stored raw, so none can leak.
 *
 * No operation logs tokens or emails (PII discipline).
 */
import type {
  MagicLinkEstimateItem,
  MagicLinkEstimateOpenResponse,
  MagicLinkEstimatesResponse,
  MagicLinkReissueResponse,
  MagicLinkVerifyFailure,
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
import { createSandboxSuppressingEmailService } from './email/sandbox-email.service';
import type { HouseholdEstimatesStore } from './household-estimates.store';
import type { LeadRecord, LeadStore } from './lead.store';
import type { UnsubscribeService } from './unsubscribe.service';
import {
  hashMagicToken,
  OWNER_LINK_PURPOSE,
  type IssuedMagicLink,
  type MagicLinkRecord,
  type MagicLinkStore,
} from './magic-link.store';

export interface MagicLinkService {
  /** Resolve a bearer token to the report it unlocks. */
  verify(token: string): Promise<MagicLinkVerifyResponse>;
  /** Idempotent resend: issues + emails a link only when none is live. */
  reissue(request: unknown): Promise<MagicLinkReissueResponse>;
  /** #800: the household's recent estimates behind a household link. */
  listEstimates(token: string): Promise<MagicLinkEstimatesResponse>;
  /** #800: mint an owner report token for one listed estimate. */
  openEstimate(request: unknown): Promise<MagicLinkEstimateOpenResponse>;
}

export interface MagicLinkServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  /** #800: newest estimate per property for an email. */
  readonly householdEstimates: HouseholdEstimatesStore;
  readonly email: EmailService;
  /** Mints the tokenized preference-page URL for the email footer. */
  readonly unsubscribe: UnsubscribeService;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  /** #800: max estimates a household link lists (config, default 10). */
  readonly householdListLimit: number;
  /**
   * #800: whether the reissue email may use the "your recent estimates"
   * copy (config MAGIC_LINK_HOUSEHOLD_LIST_EMAIL_ENABLED). Off until the
   * web list UI ships, so the email never promises a list the app doesn't
   * show. Omitted = off.
   */
  readonly householdListEmailEnabled?: boolean;
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

const openRequestSchema = z.object({
  token: z.string().trim().min(1).max(500),
  handle: z.string().uuid(),
});

/** Uniform denial — same shape as verify's invalid answer (no oracle). */
const INVALID: MagicLinkVerifyFailure = {
  valid: false,
  reason: 'invalid',
  reissueAllowed: true,
};

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
  /**
   * #800: mint a household link (lists the household's estimates). Only
   * for links that are delivered by email and never returned to a caller.
   */
  readonly household?: boolean;
  /** #800: properties the link lists; >1 switches to "recent estimates" copy. */
  readonly estimateCount?: number;
  /** #793/#914: flag the link row for the sandbox purge. */
  readonly sandbox?: boolean;
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
  /** #800: email-only household link. */
  readonly household?: boolean;
}): Promise<IssuedMagicLink> {
  return args.magicLinks.issue({
    leadId: args.leadId,
    purpose: OWNER_LINK_PURPOSE,
    ttlSeconds: args.magicLinkTtlSeconds,
    clock: args.clock,
    ...(args.sandbox ? { sandbox: true } : {}),
    ...(args.household ? { household: true } : {}),
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
  /** #800: properties the link lists; >1 switches to "recent estimates" copy. */
  readonly estimateCount?: number;
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
    ...(args.estimateCount !== undefined && args.estimateCount > 1
      ? { estimateCount: args.estimateCount }
      : {}),
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
    householdEstimates,
    householdListLimit,
    householdListEmailEnabled = false,
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
      // #800: only a live HOUSEHOLD link suppresses the resend. The link in
      // the original report email is a plain owner link (the same token the
      // lead-submit response returned), so it can't list the household's
      // estimates — a returning user asking for "my estimates" gets the
      // household link even while that one is still live. The cooldown and
      // the hourly send budget below still bound the email rate.
      const live = links
        .filter((l) => l.purpose === OWNER_LINK_PURPOSE && l.household === true)
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
      // #800: the email says "your recent estimates" when the link lists
      // more than one property — only once the web list UI is live
      // (config flag); until then it keeps the single-report copy.
      const estimateCount = householdListEmailEnabled
        ? (
            await householdEstimates.listByEmail({
              email: lead.email,
              limit: householdListLimit,
            })
          ).length
        : undefined;
      // #914: a sandbox lead (test API key / test-drive traffic) never
      // triggers a real send — route through the no-send decorator, as
      // lead.service and share.service do — and its new link is flagged so
      // the sandbox-purge timer removes it with the lead.
      const delivery = await issueAndSendMagicLink({
        magicLinks,
        email: lead.sandbox
          ? createSandboxSuppressingEmailService({
              inner: email,
              log: (message) => console.info(message),
            })
          : email,
        unsubscribe,
        leadId: lead.id,
        to: lead.email,
        name: lead.name,
        appBaseUrl,
        magicLinkTtlSeconds,
        addressKey: lead.addressKey,
        // #800: reissue links are delivered ONLY by email — possession
        // proves control of the inbox, so they may list the household.
        household: true,
        ...(estimateCount !== undefined ? { estimateCount } : {}),
        sandbox: lead.sandbox,
        clock,
      });
      // Only a delivered resend starts the cooldown — a failed send leaves
      // the window open so the user can retry immediately.
      if (delivery.sent) await reissueCooldown.start(lead.email);
      return { sent: delivery.sent };
    },

    async listEstimates(token: string): Promise<MagicLinkEstimatesResponse> {
      const resolved = await resolveOwnerToken(token);
      if (!resolved.ok) return resolved.failure;
      const { record, lead } = resolved;
      // Non-household owner tokens (lead-submit response, report email)
      // list ONLY their own property: whoever typed the email at the gate
      // holds one, so it must not reveal the household's other addresses.
      const rows = await householdEstimates.listByEmail({
        email: lead.email,
        limit: householdListLimit,
        ...(isHouseholdLink(record, lead) ? {} : { addressKey: lead.addressKey }),
      });
      const estimates: MagicLinkEstimateItem[] = rows.map((row, index) => ({
        handle: row.leadId,
        address: formatDisplayAddress(row.addressKey),
        preparedAt: row.createdAt.toISOString(),
        projectType: row.projectType === 'renovation' ? 'renovation' : 'new_build',
        latest: index === 0,
        current: row.addressKey === lead.addressKey,
      }));
      return { valid: true, estimates };
    },

    async openEstimate(request: unknown): Promise<MagicLinkEstimateOpenResponse> {
      const parsed = openRequestSchema.safeParse(request);
      if (!parsed.success) return INVALID;
      const resolved = await resolveOwnerToken(parsed.data.token);
      if (!resolved.ok) return resolved.failure;
      const { record, lead } = resolved;
      if (!isHouseholdLink(record, lead)) return INVALID;
      const target =
        parsed.data.handle === lead.id
          ? lead
          : await leads.findById(parsed.data.handle);
      // Another email's lead, an erased lead, or a quarantined one: the
      // same uniform denial — handles are not an existence oracle.
      if (!target || target.email !== lead.email || target.quarantined) {
        return INVALID;
      }
      // Always mint a plain (non-household) owner link — even for the
      // property the household token itself covers. `/r/{reportToken}` then
      // lists one item and opens the report directly (no list → list loop),
      // and the household token never appears in a shareable report URL.
      // Never extend access: the minted link expires no later than the
      // household link that opened it.
      const now = clock();
      const remainingSeconds = Math.floor(
        (record.expiresAt.getTime() - now.getTime()) / 1000,
      );
      const ttlSeconds = Math.min(magicLinkTtlSeconds, remainingSeconds);
      if (ttlSeconds <= 0) {
        return { valid: false, reason: 'expired', reissueAllowed: true };
      }
      const issued = await issueOwnerMagicLinkToken({
        magicLinks,
        leadId: target.id,
        magicLinkTtlSeconds: ttlSeconds,
        clock,
        sandbox: target.sandbox,
      });
      return { valid: true, reportToken: issued.token };
    },
  };

  /** #800: household links list; a quarantined lead's link never does. */
  function isHouseholdLink(record: MagicLinkRecord, lead: LeadRecord): boolean {
    return record.household === true && !lead.quarantined;
  }

  /**
   * Shared owner-token resolution for the #800 operations — the same rules
   * and denial shapes as `verify`: unknown, non-owner (partner-share) and
   * erased-lead tokens answer invalid; revoked/expired answer expired.
   */
  async function resolveOwnerToken(
    token: string,
  ): Promise<
    | { readonly ok: true; readonly record: MagicLinkRecord; readonly lead: LeadRecord }
    | { readonly ok: false; readonly failure: MagicLinkVerifyFailure }
  > {
    const record = await magicLinks.findByToken(token);
    if (!record || record.leadId === null || record.purpose !== OWNER_LINK_PURPOSE) {
      return { ok: false, failure: INVALID };
    }
    const lead = await leads.findById(record.leadId);
    if (!lead) return { ok: false, failure: INVALID };
    if (!isMagicLinkLive(record, clock())) {
      return {
        ok: false,
        failure: { valid: false, reason: 'expired', reissueAllowed: !lead.quarantined },
      };
    }
    return { ok: true, record, lead };
  }
}

/** Re-exported for tests that assert the stored hash (never the raw token). */
export { hashMagicToken };
