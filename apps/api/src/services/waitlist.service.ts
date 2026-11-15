/**
 * Waitlist signups (#520, decision D-P4).
 *
 * Public "tell me when it's ready" capture for renovation estimates and
 * for cities outside Calgary. Validates the contract shape, normalizes the
 * email (trim + lowercase, same rule as leads) and stores one row per
 * (email, topic). A repeat signup answers exactly like the first one, so
 * the endpoint never reveals whether an email is already on a list.
 *
 * CASL: the request must carry `consent: true` (the required checkbox,
 * wording in docs/legal/approved-copy.md "CASL waitlist consent wording");
 * the row records `consent_ts` + `consent_version`.
 *
 * No email is sent at signup: the list is read when a topic launches.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WaitlistResponse, WaitlistTopic } from '@feasly/contracts';
import { WAITLIST_CONSENT_VERSION } from '../lib/legal-copy';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { WaitlistStore } from './waitlist.store';

/** Every accepted topic (mirrors contracts `WaitlistTopic`). */
export const WAITLIST_TOPIC_VALUES = ['renovation', 'toronto', 'vancouver'] as const satisfies
  readonly WaitlistTopic[];

/** Request validation — mirrors the contracts `WaitlistRequest` shape. */
export const WaitlistRequestSchema = z
  .object({
    email: z.string().trim().min(1).max(254).email(),
    topic: z.enum(WAITLIST_TOPIC_VALUES),
    // CASL express consent (owner decision 2026-11-15): the required
    // checkbox. Anything but `true` is a 400 and nothing is stored.
    consent: z.literal(true, { error: 'consent must be true to join the waitlist.' }),
  })
  .strict();

export interface WaitlistService {
  /** Records a signup on an untrusted request body. Invalid → HttpError(400). */
  join(requestBody: unknown): Promise<WaitlistResponse>;
}

export interface WaitlistServiceDeps {
  readonly waitlist: WaitlistStore;
}

export function createWaitlistService(deps: WaitlistServiceDeps): WaitlistService {
  return {
    async join(requestBody: unknown): Promise<WaitlistResponse> {
      const parsed = WaitlistRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          parsed.error.issues[0]?.message ?? 'Invalid waitlist request.',
          false,
        );
      }
      const { email, topic } = parsed.data;
      await deps.waitlist.insertIfAbsent({
        id: randomUUID(),
        email: email.toLowerCase(),
        topic,
        consentVersion: WAITLIST_CONSENT_VERSION,
      });
      return { ok: true, topic };
    },
  };
}
