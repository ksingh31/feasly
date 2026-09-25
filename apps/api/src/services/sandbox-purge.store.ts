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
 */
import { and, eq, lt } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import {
  analyticsEvents,
  estimates,
  leads,
  magicLinks,
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
      // Order matters: children before parents.
      const magicLinksDeleted = await db
        .delete(magicLinks)
        .where(
          and(eq(magicLinks.sandbox, true), lt(magicLinks.createdAt, cutoff)),
        );
      const analyticsEventsDeleted = await db
        .delete(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.sandbox, true),
            lt(analyticsEvents.createdAt, cutoff),
          ),
        );
      const leadsDeleted = await db
        .delete(leads)
        .where(and(eq(leads.sandbox, true), lt(leads.createdAt, cutoff)));
      const estimatesDeleted = await db
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
