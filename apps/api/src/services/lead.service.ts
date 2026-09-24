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
 * Magic-link emailing is BE-5's queue — `magicLinkSent` is false until then.
 * `expiresInDays` is derived from the configured magic-link TTL so the UI
 * never hardcodes it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LeadResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';

/**
 * Contract-shaped validation. `timeline` defaults to 'exploring' and
 * `marketingConsent` is required-but-possibly-false — the UI sends false when
 * the CASL checkbox is unchecked, and the service must honor that.
 */
export const LeadRequestSchema = z.object({
  email: z.string().trim().min(1).max(254).email(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(40).optional(),
  timeline: z.enum(['0-3mo', '3-6mo', '6-12mo', '12+mo', 'exploring']).default('exploring'),
  marketingConsent: z.boolean(),
  estimateId: z.string().uuid(),
  tenantKey: z.string().trim().min(1).max(120).optional(),
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
  /** 90-day window: same email + address → existing lead. */
  readonly dedupWindowDays: number;
  /** Magic-link TTL, seconds — drives the UI's `expiresInDays`. */
  readonly magicLinkTtlSeconds: number;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

const MS_PER_DAY = 86_400_000;

export function createLeadService(deps: LeadServiceDeps): LeadService {
  const clock = deps.clock ?? (() => new Date());

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
        return { leadId: existing.id, magicLinkSent: false, expiresInDays };
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
          tenantKey: input.tenantKey,
          source: 'api',
        });
      } catch (error) {
        throw new Error('lead store insert failed', { cause: error });
      }
      return { leadId: inserted.id, magicLinkSent: false, expiresInDays };
    },
  };
}
