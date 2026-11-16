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
 * the row records `consent_ts` + `consent_version` (from
 * `config.waitlist.consentVersion`, #740).
 *
 * No email is sent at signup: the list is read when a topic launches.
 *
 * #689: the `building-form` topic records interest in a form the district
 * typically allows but the engine does not price yet, with the lot's
 * district and community. One row per (email, topic, form).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BUILDING_FORMS,
  type BuildingForm,
  type WaitlistResponse,
  type WaitlistTopic,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { WaitlistStore } from './waitlist.store';

/** Every accepted topic (mirrors contracts `WaitlistTopic`). */
export const WAITLIST_TOPIC_VALUES = [
  'renovation',
  'toronto',
  'vancouver',
  'building-form',
] as const satisfies readonly WaitlistTopic[];

/** #689: the topic whose signups carry a building form + district + community. */
export const BUILDING_FORM_TOPIC = 'building-form' satisfies WaitlistTopic;

/** #689: longest district code / community name accepted (generous bounds). */
const MAX_DISTRICT_LENGTH = 40;
const MAX_COMMUNITY_LENGTH = 120;

/** Request validation — mirrors the contracts `WaitlistRequest` shape. */
export const WaitlistRequestSchema = z
  .object({
    email: z.string().trim().min(1).max(254).email(),
    topic: z.enum(WAITLIST_TOPIC_VALUES),
    // CASL express consent (owner decision 2026-11-15): the required
    // checkbox. Anything but `true` is a 400 and nothing is stored.
    consent: z.literal(true, { error: 'consent must be true to join the waitlist.' }),
    // #689: building-form interest — the form, the lot's district and community.
    buildingForm: z.enum(BUILDING_FORMS as readonly [BuildingForm, ...BuildingForm[]]).optional(),
    district: z.string().trim().min(1).max(MAX_DISTRICT_LENGTH).optional(),
    community: z.string().trim().min(1).max(MAX_COMMUNITY_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const formTopic = value.topic === BUILDING_FORM_TOPIC;
    if (formTopic && value.buildingForm === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['buildingForm'],
        message: 'buildingForm is required for the building-form waitlist.',
      });
    }
    if (
      !formTopic &&
      (value.buildingForm !== undefined ||
        value.district !== undefined ||
        value.community !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['topic'],
        message: 'buildingForm, district and community are only accepted for the building-form waitlist.',
      });
    }
  });

export interface WaitlistService {
  /** Records a signup on an untrusted request body. Invalid → HttpError(400). */
  join(requestBody: unknown): Promise<WaitlistResponse>;
}

export interface WaitlistServiceDeps {
  readonly waitlist: WaitlistStore;
  /** `config.waitlist.consentVersion` — stored as `consent_version`. */
  readonly consentVersion: string;
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
      const { email, topic, buildingForm, district, community } = parsed.data;
      await deps.waitlist.insertIfAbsent({
        id: randomUUID(),
        email: email.toLowerCase(),
        topic,
        consentVersion: deps.consentVersion,
        buildingForm: buildingForm ?? null,
        district: district ?? null,
        community: community ?? null,
      });
      return { ok: true, topic };
    },
  };
}
