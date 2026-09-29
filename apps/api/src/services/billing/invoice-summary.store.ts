/**
 * Drizzle-backed InvoiceSummaryStore (record-contract flow redesign).
 *
 * Display-safe per-tenant invoice summaries for the builder portal: which
 * leads already have a commission invoice, with the figures the UI needs
 * for the "already recorded" state (invoice id, contract value, commission,
 * status, review deadline). Only services import from this module (layer
 * boundary: routes and middleware never touch the db directly).
 *
 * Kept separate from CommissionService on purpose: the builder lead list
 * needs one tenant-scoped DISTINCT-lead query, not the paginated invoice
 * list, and this module carries no charge-path logic.
 */
import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { commissionInvoices } from '../../db/schema';

/** Display-safe invoice summary for one recorded contract. */
export interface InvoiceSummaryRecord {
  readonly id: string;
  readonly leadId: string;
  readonly contractValueCents: number;
  readonly commissionCents: number;
  readonly status: string;
  readonly reviewDueAt: Date | null;
}

export interface InvoiceSummaryStore {
  /**
   * Every invoice for the tenant, newest first. The caller builds the
   * lead→invoice lookup; one invoice per attribution is enforced by the
   * DB unique constraint, so the first row per lead wins.
   */
  findByTenantKey(tenantKey: string): Promise<readonly InvoiceSummaryRecord[]>;
}

export interface InvoiceSummaryStoreDeps {
  readonly db: AppDb;
}

export function createInvoiceSummaryStore(
  deps: InvoiceSummaryStoreDeps,
): InvoiceSummaryStore {
  const { db } = deps;

  return {
    async findByTenantKey(
      tenantKey: string,
    ): Promise<readonly InvoiceSummaryRecord[]> {
      const rows = await db
        .select({
          id: commissionInvoices.id,
          leadId: commissionInvoices.leadId,
          contractValueCents: commissionInvoices.contractValueCents,
          commissionCents: commissionInvoices.commissionCents,
          status: commissionInvoices.status,
          reviewDueAt: commissionInvoices.reviewDueAt,
        })
        .from(commissionInvoices)
        .where(eq(commissionInvoices.tenantKey, tenantKey))
        // Newest first: the caller's lead→invoice lookup keeps the first
        // row per lead, which must be deterministic.
        .orderBy(desc(commissionInvoices.createdAt));
      return rows;
    },
  };
}
