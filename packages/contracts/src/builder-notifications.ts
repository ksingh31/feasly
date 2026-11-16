/**
 * Builder notification preferences (#725).
 *
 * One row of preferences per builder team member per org. The only channel
 * is email (SMS is out of scope — owner decision 2026-11-15). Defaults when
 * a member never saved preferences (owner decision 2026-11-15):
 *   - `newLeadEmail`: on for every active member (opt-out);
 *   - `needsYouDigest`: off (opt-in daily "Needs you" digest);
 *   - `billingEmail`: on. Commission emails go to every active builder
 *     admin with it on; the last such admin cannot turn it off.
 *
 * New-lead emails carry the lead's first name, community, project type and a
 * deep link to the lead in the portal — never the homeowner's email or phone.
 */

/** The only delivery channel today. */
export type BuilderNotificationChannel = 'email';

export interface BuilderNotificationPreferences {
  /** One email per new lead assigned to the org (default on). */
  readonly newLeadEmail: boolean;
  /** Daily digest of the "Needs you" feed; skipped when empty (default off). */
  readonly needsYouDigest: boolean;
  /** Commission invoice and payment emails — admins only (default on). */
  readonly billingEmail: boolean;
}

/**
 * `GET /api/v1/builder/notifications/preferences` and the `PUT` response.
 */
export interface BuilderNotificationPreferencesResponse {
  readonly channel: BuilderNotificationChannel;
  readonly preferences: BuilderNotificationPreferences;
  /** The signed-in member's org role — billing emails go to admins only. */
  readonly role: 'builder_admin' | 'builder_member';
  /**
   * False when this member is the org's last active admin with billing
   * emails on: a `PUT` with `billingEmail: false` is then rejected (409).
   */
  readonly canDisableBillingEmail: boolean;
}

/**
 * `PUT /api/v1/builder/notifications/preferences` body. Partial: omitted
 * fields keep their current value. Unknown fields are rejected.
 */
export interface BuilderNotificationPreferencesUpdateBody {
  readonly newLeadEmail?: boolean;
  readonly needsYouDigest?: boolean;
  readonly billingEmail?: boolean;
}
