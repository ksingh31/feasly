/**
 * Lead-gate service (BE3-003).
 *
 * Responsibilities (and nothing else):
 *  1. Validate the request shape with Zod against the contracts `LeadRequest`.
 *  2. Normalize the email (trim + lowercase) — dedup is an exact match on the
 *     normalized form.
 *  3. Reject references to unknown estimates (the lead must attach to a real
 *     persisted estimate).
 *  4. 90-day dedup: same email + same property address (address_key
 *     denormalized from the estimate) inside the configured window returns
 *     the existing lead — no duplicate row, no duplicate email. A fresh
 *     estimate for the same address is still the same household.
 *  5. Otherwise insert and return the contract `LeadResponse`.
 *
 * PII discipline: error messages reference field *paths* ('email'), never
 * field *values*. Nothing in this service logs; the pipeline logger only ever
 * sees these messages.
 *
 * consumer/02 duplicate-estimate semantics:
 * - Dedupe HIT (same email + address inside the window): the existing lead
 *   is UPDATED in place — name, phone, timeline, lead_score (recomputed
 *   from the latest submission), estimate_id → newest. Email, address,
 *   consent, consent_ts, status, notes, and status history are never
 *   touched (the store's `updateOnRepeat` column list is the guarantee).
 * - AC4: on a dedupe hit the magic-link email is sent ONLY when the lead
 *   has no live link (expired or missing → reissue). A live link means
 *   zero new sends.
 * - New capture: the magic-link email is sent immediately (this wires the
 *   BE-5/email seam — `magicLinkSent` is true on success). Quarantined
 *   (honeypot) rows are issued a token but never emailed.
 * `expiresInDays` is derived from the configured magic-link TTL so the UI
 * never hardcodes it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LeadResponse } from '@feasly/contracts';
import { computeLeadScore } from '../lib/lead-score';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { BuilderConfigService } from './builder-config.service';
import type { EmailService } from './email/email.service';
import type { EstimateStore } from './estimate.store';
import type { LeadRecord, LeadStore } from './lead.store';
import { isMagicLinkLive, issueAndSendMagicLink } from './magic-link.service';
import type { MagicLinkStore } from './magic-link.store';

/**
 * Contract-shaped validation. `timeline` defaults to 'exploring' and
 * `marketingConsent` is required-but-possibly-false — the UI sends false when
 * the CASL checkbox is unchecked, and the service must honor that.
 *
 * `website` is the HRD-03 honeypot: the UI renders it as a visually-hidden
 * input no real user fills. A non-empty value does NOT fail validation —
 * the lead is captured with `quarantined: true` and the caller gets the
 * normal response, so bots learn nothing.
 */
export const LeadRequestSchema = z.object({
  email: z.string().trim().min(1).max(254).email(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(40).optional(),
  timeline: z.enum(['0-3mo', '3-6mo', '6-12mo', '12+mo', 'exploring']).default('exploring'),
  marketingConsent: z.boolean(),
  estimateId: z.string().uuid(),
  tenantKey: z.string().trim().min(1).max(120).optional(),
  website: z.string().max(500).optional(),
});

export type LeadRequest = z.infer<typeof LeadRequestSchema>;

export interface LeadService {
  /**
   * Capture a lead. Rejects with HttpError(400) for invalid input or an
   * unknown estimateId; resolves to the contract `LeadResponse`.
   */
  submitLead(requestBody: unknown): Promise<LeadResponse>;
}

export interface LeadServiceDeps {
  readonly store: LeadStore;
  /** Used to verify the estimateId references a persisted estimate. */
  readonly estimateStore: EstimateStore;
  /** Issues the magic-link bearer token for every captured lead. */
  readonly magicLinks: MagicLinkStore;
  /** Sends the magic-link email (consumer/02 wires the BE-5 seam). */
  readonly email: EmailService;
  /** From config — minted into the magic-link URL, never hardcoded. */
  readonly appBaseUrl: string;
  /** 90-day window: same email + address → existing lead. */
  readonly dedupWindowDays: number;
  /** Magic-link TTL, seconds — drives the UI's `expiresInDays`. */
  readonly magicLinkTtlSeconds: number;
  /** Validates embed tenant keys (EMB-03). Optional — embeds disabled when absent. */
  readonly builderConfigs?: BuilderConfigService;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

const MS_PER_DAY = 86_400_000;

/**
 * Defensive read of the estimate figures' total-base (whole CAD dollars).
 * The figures shape is versioned (`costDataVersion`); never let an
 * unexpected shape fail a lead capture — the score just skips the band.
 */
function extractTotalBase(figures: unknown): number | undefined {
  if (typeof figures !== 'object' || figures === null) return undefined;
  const total = (figures as { readonly total?: unknown }).total;
  if (typeof total !== 'object' || total === null) return undefined;
  const base = (total as { readonly base?: unknown }).base;
  return typeof base === 'number' && Number.isFinite(base) ? base : undefined;
}

export function createLeadService(deps: LeadServiceDeps): LeadService {
  const clock = deps.clock ?? (() => new Date());

  /**
   * EMB-03: resolve and validate the embed tenant key server-side.
   * An unknown key is a 400 — the client must not invent tenants.
   */
  async function resolveTenantKey(tenantKey: string): Promise<string> {
    if (!deps.builderConfigs) {
      throw new HttpError(
        400,
        ErrorCodes.VALIDATION_FAILED,
        'Embed tenant keys are not supported.',
        false,
      );
    }
    try {
      await deps.builderConfigs.getByKey(tenantKey);
    } catch {
      throw new HttpError(
        400,
        ErrorCodes.VALIDATION_FAILED,
        'Unknown tenant key.',
        false,
      );
    }
    return tenantKey;
  }

  /**
   * consumer/02 — the dedupe-hit path. Updates the existing lead's scalar
   * columns (name, phone, timeline, lead_score, estimate_id → newest) and
   * sends a magic-link email ONLY when the lead has no live link (AC4).
   */
  async function handleRepeatEstimate(args: {
    readonly existing: LeadRecord;
    readonly input: LeadRequest;
    readonly estimate: { readonly figures: unknown };
    readonly email: string;
    readonly now: Date;
    readonly expiresInDays: number;
  }): Promise<LeadResponse> {
    const { existing, input, estimate, email, now, expiresInDays } = args;
    if (existing.quarantined) {
      // Spam stays buried: no update, no email, same response shape.
      return { leadId: existing.id, magicLinkSent: false, expiresInDays };
    }
    const effectivePhone = input.phone ?? existing.phone ?? undefined;
    const leadScore = computeLeadScore({
      timeline: input.timeline,
      marketingConsent: existing.marketingConsent,
      hasPhone: effectivePhone !== undefined && effectivePhone.length > 0,
      estimateTotalBase: extractTotalBase(estimate.figures),
    });
    let updated: LeadRecord;
    try {
      updated = await deps.store.updateOnRepeat({
        id: existing.id,
        name: input.name,
        phone: input.phone,
        timeline: input.timeline,
        leadScore,
        estimateId: input.estimateId,
      });
    } catch (error) {
      throw new Error('lead dedupe update failed', { cause: error });
    }
    // AC4: a live magic link means zero new sends. Only an expired or
    // missing link takes the reissue path.
    let links;
    try {
      links = await deps.magicLinks.findByLeadIds([existing.id]);
    } catch (error) {
      throw new Error('magic link lookup failed', { cause: error });
    }
    const live = links
      .filter((l) => l.purpose === 'lead')
      .some((l) => isMagicLinkLive(l, now));
    if (live) {
      return { leadId: updated.id, magicLinkSent: false, expiresInDays };
    }
    try {
      await issueAndSendMagicLink({
        magicLinks: deps.magicLinks,
        email: deps.email,
        leadId: existing.id,
        to: email,
        name: input.name,
        appBaseUrl: deps.appBaseUrl,
        magicLinkTtlSeconds: deps.magicLinkTtlSeconds,
        clock,
      });
    } catch (error) {
      throw new Error('magic link reissue failed', { cause: error });
    }
    return { leadId: updated.id, magicLinkSent: true, expiresInDays };
  }

  return {
    async submitLead(requestBody: unknown): Promise<LeadResponse> {
      const parsed = LeadRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first ? first.path.join('.') : 'body';
        // Field path only — never echo the submitted value (PII).
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Invalid lead request at '${where}'.`,
          false,
        );
      }
      const input = parsed.data;
      const email = input.email.toLowerCase();

      const estimate = await deps.estimateStore.findById(input.estimateId);
      if (!estimate) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Unknown estimateId.',
          false,
        );
      }

      const now = clock();
      const since = new Date(now.getTime() - deps.dedupWindowDays * MS_PER_DAY);
      // PII guard: store failures are rethrown sanitized (the original is
      // chained as `cause` for programmatic inspection but never reaches
      // logs — driver errors can echo submitted values).
      let existing;
      try {
        existing = await deps.store.findRecentByEmailAndAddress({
          email,
          addressKey: estimate.addressKey,
          since,
        });
      } catch (error) {
        throw new Error('lead store lookup failed', { cause: error });
      }
      const expiresInDays = Math.max(1, Math.ceil(deps.magicLinkTtlSeconds / 86_400));
      if (existing) {
        return handleRepeatEstimate({
          existing,
          input,
          estimate,
          email,
          now,
          expiresInDays,
        });
      }

      // HRD-03 honeypot: a filled trap field quarantines the row instead of
      // rejecting the request — the response shape is identical to a clean
      // capture so bots can't probe for the trap.
      const quarantined = (input.website ?? '').trim().length > 0;

      // EMB-03: resolve the embed tenant key server-side. The key is
      // validated against the tenants table — a forged or unknown key is a
      // 400, never silently trusted. A client-supplied `tenant_id` field is
      // not in the schema, so Zod strips it; only the validated key wins.
      let tenantKey: string | undefined;
      let source = 'api';
      if (input.tenantKey !== undefined) {
        tenantKey = await resolveTenantKey(input.tenantKey);
        source = 'embed';
      }

      let inserted;
      try {
        inserted = await deps.store.insert({
          id: randomUUID(),
          estimateId: input.estimateId,
          addressKey: estimate.addressKey,
          email,
          name: input.name,
          phone: input.phone,
          timeline: input.timeline,
          marketingConsent: input.marketingConsent,
          consentTs: now,
          tenantKey,
          source,
          quarantined,
        });
      } catch (error) {
        throw new Error('lead store insert failed', { cause: error });
      }
      // legal/02: every captured lead gets a magic-link bearer token — the
      // credential for the PIPEDA self-service endpoints. consumer/02 wires
      // the BE-5/email seam: the link is emailed immediately (log provider
      // until ACS is provisioned). Quarantined rows are issued a token but
      // never emailed — no mail for suspected bots.
      try {
        if (quarantined) {
          await deps.magicLinks.issue({
            leadId: inserted.id,
            ttlSeconds: deps.magicLinkTtlSeconds,
            clock,
          });
        } else {
          await issueAndSendMagicLink({
            magicLinks: deps.magicLinks,
            email: deps.email,
            leadId: inserted.id,
            to: email,
            name: input.name,
            appBaseUrl: deps.appBaseUrl,
            magicLinkTtlSeconds: deps.magicLinkTtlSeconds,
            clock,
          });
        }
      } catch (error) {
        throw new Error('magic link issuance failed', { cause: error });
      }
      return {
        leadId: inserted.id,
        magicLinkSent: !quarantined,
        expiresInDays,
      };
    },
  };
}
