/**
 * Waitlist contracts (#520, decision D-P4).
 *
 * "Tell me when it's ready" capture for things Feasly does not estimate
 * yet: renovation projects and cities outside Calgary (Toronto, Vancouver).
 * The email is the only personal data. One row per (email, topic): a repeat
 * signup is idempotent and answers exactly like the first one, so the
 * endpoint never reveals whether an email is already on a list.
 *
 * #689 adds the `building-form` topic: interest in a building form the
 * district typically allows but the engine does not price yet. Those
 * signups also record the form, the lot's district and its community.
 */
import type { BuildingForm } from './zoning';

/** What the person wants to hear about. */
export type WaitlistTopic = 'renovation' | 'toronto' | 'vancouver' | 'building-form';

export interface WaitlistRequest {
  readonly email: string;
  readonly topic: WaitlistTopic;
  /**
   * CASL express consent (owner decision 2026-11-15): the required
   * checkbox. The API rejects a signup without `consent: true`.
   */
  readonly consent: true;
  /**
   * #689: the building form the person wants priced. Required when
   * `topic` is `building-form`, refused on any other topic. One signup is
   * kept per (email, topic, buildingForm).
   */
  readonly buildingForm?: BuildingForm;
  /** #689: the lot's land-use district code, as shown (building-form topic only). */
  readonly district?: string;
  /** #689: the lot's community name (building-form topic only). */
  readonly community?: string;
}

export interface WaitlistResponse {
  readonly ok: true;
  readonly topic: WaitlistTopic;
}
