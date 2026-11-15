/**
 * Waitlist contracts (#520, decision D-P4).
 *
 * "Tell me when it's ready" capture for things Feasly does not estimate
 * yet: renovation projects and cities outside Calgary (Toronto, Vancouver).
 * The email is the only personal data. One row per (email, topic): a repeat
 * signup is idempotent and answers exactly like the first one, so the
 * endpoint never reveals whether an email is already on a list.
 */

/** What the person wants to hear about. */
export type WaitlistTopic = 'renovation' | 'toronto' | 'vancouver';

export interface WaitlistRequest {
  readonly email: string;
  readonly topic: WaitlistTopic;
  /**
   * CASL express consent (owner decision 2026-11-15): the required
   * checkbox. The API rejects a signup without `consent: true`.
   */
  readonly consent: true;
}

export interface WaitlistResponse {
  readonly ok: true;
  readonly topic: WaitlistTopic;
}
