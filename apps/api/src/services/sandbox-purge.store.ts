/**
 * Drizzle implementation of the sandbox purge store (api-mcp/09).
 *
 * Hard-deletes sandbox rows older than the cutoff across the four
 * tables that carry the `sandbox` flag. Deletion order respects FKs:
 * magic_links → analytics_events → leads → estimates.
 *
 * - `leads` delete cascades to `lead_notes` + `lead_status_history`
 *   (ON DELETE CASCADE in the schema).
 * - `magic_links.lead_id` is SET NULL on lead delete — sandbox links are
 *   purged directly first, so no orphans remain.
 * - `estimates` are deleted last: `leads.estimate_id` has no ON DELETE
 *   action, so leads must go first.
 * - #793: sandbox leads get a working report token, so the token-gated
 *   extras can create `report_snapshots`, `callback_requests` and
 *   `partner_shares` rows. Those carry no sandbox flag and their FKs to
 *   leads/estimates are RESTRICT, so they're deleted first — scoped to
 *   the exact sandbox leads/estimates about to be purged. They're not
 *   counted separately (they're dependents, not sandbox-flagged rows).
 */
import { and, eq, inArray, lt, or } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import {
  analyticsEvents,
  callbackRequests,
  estimates,
  leads,
  magicLinks,
  partnerShares,
  reportSnapshots,
} from '../db/schema';
import type {
  PurgeCounts,
  SandboxPurgeStore,
} from './sandbox-purge.service';

export interface DrizzleSandboxPurgeStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleSandboxPurgeStore(
  deps: DrizzleSandboxPurgeStoreDeps,
): SandboxPurgeStore {
  const { db } = deps;

  return {
    async purgeOldSandboxRows(cutoff: Date): Promise<PurgeCounts> {
      // #840: one transaction — a mid-way failure (e.g. an FK violation
      // on `leads`) rolls back every delete, never leaving a partial purge.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return db.transaction(async (tx: any) => purgeInTx(tx as AppDb, cutoff));
    },

    async countOldSandboxRows(cutoff: Date): Promise<PurgeCounts> {
      const [ml, ae, l, e] = await Promise.all([
        db
          .select({ id: magicLinks.id })
          .from(magicLinks)
          .where(
            and(eq(magicLinks.sandbox, true), lt(magicLinks.createdAt, cutoff)),
          ),
        db
          .select({ id: analyticsEvents.id })
          .from(analyticsEvents)
          .where(
            and(
              eq(analyticsEvents.sandbox, true),
              lt(analyticsEvents.createdAt, cutoff),
            ),
          ),
        db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.sandbox, true), lt(leads.createdAt, cutoff))),
        db
          .select({ id: estimates.id })
          .from(estimates)
          .where(
            and(eq(estimates.sandbox, true), lt(estimates.createdAt, cutoff)),
          ),
      ]);
      return {
        magicLinks: ml.length,
        analyticsEvents: ae.length,
        leads: l.length,
        estimates: e.length,
      };
    },
  };
}

/**
 * The purge's deletes, in FK order (children before parents), against a
 * transaction handle.
 */
async function purgeInTx(tx: AppDb, cutoff: Date): Promise<PurgeCounts> {
  const magicLinksDeleted = await tx
    .delete(magicLinks)
    .where(
      and(eq(magicLinks.sandbox, true), lt(magicLinks.createdAt, cutoff)),
    );
  const analyticsEventsDeleted = await tx
    .delete(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.sandbox, true),
        lt(analyticsEvents.createdAt, cutoff),
      ),
    );
  // #793: lead/estimate dependents without a sandbox flag (RESTRICT FKs).
  const purgeLeadIds = tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.sandbox, true), lt(leads.createdAt, cutoff)));
  const purgeEstimateIds = tx
    .select({ id: estimates.id })
    .from(estimates)
    .where(
      and(eq(estimates.sandbox, true), lt(estimates.createdAt, cutoff)),
    );
  await tx
    .delete(reportSnapshots)
    .where(
      or(
        inArray(reportSnapshots.leadId, purgeLeadIds),
        inArray(reportSnapshots.estimateId, purgeEstimateIds),
      ),
    );
  await tx
    .delete(callbackRequests)
    .where(inArray(callbackRequests.leadId, purgeLeadIds));
  await tx
    .delete(partnerShares)
    .where(inArray(partnerShares.leadId, purgeLeadIds));

  const leadsDeleted = await tx
    .delete(leads)
    .where(and(eq(leads.sandbox, true), lt(leads.createdAt, cutoff)));
  const estimatesDeleted = await tx
    .delete(estimates)
    .where(
      and(eq(estimates.sandbox, true), lt(estimates.createdAt, cutoff)),
    );

  return {
    magicLinks: countOf(magicLinksDeleted),
    analyticsEvents: countOf(analyticsEventsDeleted),
    leads: countOf(leadsDeleted),
    estimates: countOf(estimatesDeleted),
  };
}

/**
 * Drizzle's delete() resolves to the raw pg result. The row count lives
 * in `rowCount`; fall back to 0 when the driver doesn't provide it.
 */
function countOf(result: unknown): number {
  if (
    typeof result === 'object' &&
    result !== null &&
    'rowCount' in result &&
    typeof (result as { rowCount: unknown }).rowCount === 'number'
  ) {
    return (result as { rowCount: number }).rowCount;
  }
  return 0;
}
