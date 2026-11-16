/**
 * Post-report follow-up persistence (#703).
 *
 * Two lead columns back the follow-up email:
 *   - `report_opened_at` — first owner-link report open, stamped once by
 *     the report service and never overwritten;
 *   - `follow_up_sent_at` — exactly-once guard (NULL = not yet sent).
 *
 * Kept out of `LeadStore` on purpose (same reasoning as
 * `LeadStatusChangeStore`): a separate interface keeps every existing
 * LeadStore fake unchanged.
 */
import { and, eq, gte, isNull, lt, notExists } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { callbackRequests, leads } from '../db/schema';

export interface LeadFollowUpState {
  readonly reportOpenedAt: Date | null;
  readonly followUpSentAt: Date | null;
}

export interface LeadFollowUpStore {
  /**
   * Stamp the first report open. A no-op when the lead already has a
   * stamp (first open wins) or no longer exists (erased).
   */
  markReportOpened(args: { readonly leadId: string; readonly at: Date }): Promise<void>;
  /**
   * Lead ids whose report was first opened in `[openedAfter, openedBefore)`
   * and that are eligible for the follow-up at the SQL level: marketing
   * consent, not yet followed up, not unsubscribed / contact-opted-out,
   * not quarantined, not sandbox, and (#838) no builder contact requested
   * (no callback request). The service re-checks before sending.
   */
  findCandidates(args: {
    readonly openedAfter: Date;
    readonly openedBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]>;
  /** Follow-up columns for one lead; null when the lead does not exist. */
  findState(leadId: string): Promise<LeadFollowUpState | null>;
  /** #838: true when the lead asked for a builder callback. */
  hasCallbackRequest(leadId: string): Promise<boolean>;
  /** Record the follow-up send (exactly-once guard). */
  setFollowUpSentAt(args: { readonly leadId: string; readonly at: Date }): Promise<void>;
}

export function createDrizzleLeadFollowUpStore(deps: {
  readonly db: AppDb;
}): LeadFollowUpStore {
  const { db } = deps;
  return {
    async markReportOpened(args) {
      await db
        .update(leads)
        .set({ reportOpenedAt: args.at })
        .where(and(eq(leads.id, args.leadId), isNull(leads.reportOpenedAt)));
    },

    async findCandidates(args) {
      const rows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            gte(leads.reportOpenedAt, args.openedAfter),
            lt(leads.reportOpenedAt, args.openedBefore),
            isNull(leads.followUpSentAt),
            eq(leads.marketingConsent, true),
            isNull(leads.unsubscribedAt),
            isNull(leads.contactOptOutAt),
            eq(leads.quarantined, false),
            eq(leads.sandbox, false),
            notExists(
              db
                .select({ id: callbackRequests.id })
                .from(callbackRequests)
                .where(eq(callbackRequests.leadId, leads.id)),
            ),
          ),
        )
        .orderBy(leads.reportOpenedAt)
        .limit(args.limit);
      return rows.map((r) => r.id);
    },

    async findState(leadId) {
      const rows = await db
        .select({
          reportOpenedAt: leads.reportOpenedAt,
          followUpSentAt: leads.followUpSentAt,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      return rows[0] ?? null;
    },

    async hasCallbackRequest(leadId) {
      const rows = await db
        .select({ id: callbackRequests.id })
        .from(callbackRequests)
        .where(eq(callbackRequests.leadId, leadId))
        .limit(1);
      return rows.length > 0;
    },

    async setFollowUpSentAt(args) {
      await db
        .update(leads)
        .set({ followUpSentAt: args.at })
        .where(eq(leads.id, args.leadId));
    },
  };
}
