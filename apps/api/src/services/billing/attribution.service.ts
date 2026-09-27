/**
 * Attribution service (billing/01 foundation).
 *
 * Owns the lead→builder introduction lifecycle that the 1% commission model
 * bills against. This is the FOUNDATION only — recording introductions,
 * contract reports, and status transitions with the attribution window and
 * reporting-SLA deadlines enforced. It does NOT compute commissions, charge
 * builders, or pay out: those wait on api-mcp/08 + embed/09.
 *
 * Status lifecycle:
 *   introduced → attributed (contract reported inside the window)
 *   introduced → expired (window lapsed, no contract)
 *   introduced → excluded_prior_relationship (builder proved a pre-existing
 *     relationship — proof burden on the builder, Karan 2026-09-24)
 * Terminal states (attributed / expired / excluded_prior_relationship) have
 * no outgoing transitions.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import { attributionEvents } from '../../db/schema';
import { HttpError, ErrorCodes } from '../../middleware/errors';
import {
  attributionDeadline,
  isWithinAttributionWindow,
  reportingDeadline,
} from '../../lib/billing-deadlines';
import { isUniqueViolation } from './pg-errors';

export type AttributionStatus =
  | 'introduced'
  | 'attributed'
  | 'expired'
  | 'excluded_prior_relationship';

export interface AttributionRecord {
  readonly id: string;
  readonly leadId: string;
  readonly tenantKey: string;
  readonly introducedAt: Date;
  readonly contractValueCents: number | null;
  readonly contractSignedAt: Date | null;
  readonly status: AttributionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RecordIntroductionInput {
  readonly leadId: string;
  readonly tenantKey: string;
  /** Defaults to now (via the injected clock). */
  readonly introducedAt?: Date;
}

export interface ReportContractInput {
  readonly attributionId: string;
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
  readonly contractSignedAt: Date;
  /** Defaults to now (via the injected clock). */
  readonly reportedAt?: Date;
}

export interface AttributionService {
  /**
   * Record a lead→builder introduction (opens the attribution window).
   * Idempotent per open (lead, tenant): a concurrent duplicate returns the
   * existing open introduction (UNIQUE backstop, migration 0034).
   */
  recordIntroduction(input: RecordIntroductionInput): Promise<AttributionRecord>;
  /**
   * Record a signed contract against an introduction. Rejects when the
   * signature falls outside the attribution window.
   */
  reportContract(input: ReportContractInput): Promise<AttributionRecord>;
  /** Close an introduction whose window lapsed with no reported contract. */
  markExpired(attributionId: string): Promise<AttributionRecord>;
  /** Builder proved a pre-existing relationship — excluded from billing. */
  excludePriorRelationship(attributionId: string): Promise<AttributionRecord>;
  getById(attributionId: string): Promise<AttributionRecord>;
  /**
   * The newest non-terminal attribution for a lead+tenant, or null when the
   * lead has no open introduction. Used by the billing won-flow to stay
   * idempotent: one lead yields at most one open attribution.
   */
  findOpenByLead(
    leadId: string,
    tenantKey: string,
  ): Promise<AttributionRecord | null>;
  /**
   * The 14-day reporting deadline for a reported contract, or null when no
   * contract has been reported yet.
   */
  reportingDeadlineFor(record: AttributionRecord): Date | null;
  /**
   * The last instant a contract signed for this introduction still
   * attributes to Feasly.
   */
  attributionDeadlineFor(record: AttributionRecord): Date;
}

export interface AttributionServiceDeps {
  readonly db: AppDb;
  readonly billing: BillingConfig;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
  /** Defaults to node:crypto randomUUID; tests inject a fixed id. */
  readonly newId?: () => string;
}

const TERMINAL_STATUSES: ReadonlySet<AttributionStatus> = new Set([
  'attributed',
  'expired',
  'excluded_prior_relationship',
]);

/**
 * True when the stored contract matches the incoming report — the
 * idempotency key for duplicate reportContract calls (P0, 2026-09-27).
 */
function sameContractDetails(
  row: typeof attributionEvents.$inferSelect,
  input: ReportContractInput,
): boolean {
  return (
    row.contractValueCents === input.contractValueCents &&
    row.contractSignedAt !== null &&
    row.contractSignedAt.getTime() === input.contractSignedAt.getTime()
  );
}

function toRecord(row: typeof attributionEvents.$inferSelect): AttributionRecord {  const status = row.status as AttributionStatus;
  return {
    id: row.id,
    leadId: row.leadId,
    tenantKey: row.tenantKey,
    introducedAt: row.introducedAt,
    contractValueCents: row.contractValueCents,
    contractSignedAt: row.contractSignedAt,
    status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createAttributionService(deps: AttributionServiceDeps): AttributionService {
  const { db, billing } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  async function requireOpen(id: string): Promise<typeof attributionEvents.$inferSelect> {
    const row = await db.query.attributionEvents.findFirst({
      where: eq(attributionEvents.id, id),
    });
    if (row === undefined) {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, `Attribution not found: "${id}"`);
    }
    if (TERMINAL_STATUSES.has(row.status as AttributionStatus)) {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        `Attribution "${id}" is already ${row.status} and cannot transition`,
      );
    }
    return row;
  }

  return {
    async recordIntroduction(input: RecordIntroductionInput): Promise<AttributionRecord> {
      const introducedAt = input.introducedAt ?? now();
      try {
        const [row] = await db
          .insert(attributionEvents)
          .values({
            id: newId(),
            leadId: input.leadId,
            tenantKey: input.tenantKey,
            introducedAt,
            status: 'introduced',
          })
          .returning();
        return toRecord(row);
      } catch (error) {
        // Lost the introduction race: the UNIQUE backstop on open
        // (lead_id, tenant_key) (migration 0034) rejected our insert because
        // a concurrent won event introduced the same lead first. Reuse the
        // winner — one open introduction per lead+tenant, never a 500.
        if (!isUniqueViolation(error)) throw error;
        const winner = await db.query.attributionEvents.findFirst({
          where: and(
            eq(attributionEvents.leadId, input.leadId),
            eq(attributionEvents.tenantKey, input.tenantKey),
            eq(attributionEvents.status, 'introduced'),
          ),
        });
        if (winner === undefined) throw error;
        return toRecord(winner);
      }
    },

    async reportContract(input: ReportContractInput): Promise<AttributionRecord> {
      if (!Number.isInteger(input.contractValueCents) || input.contractValueCents <= 0) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          'contractValueCents must be a positive integer (cents, excl. land)',
        );
      }
      // Single fetch: the idempotency decision and the transition guard must
      // see the same row, otherwise the check-then-act race just moves.
      const row = await db.query.attributionEvents.findFirst({
        where: eq(attributionEvents.id, input.attributionId),
      });
      if (row === undefined) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, `Attribution not found: "${input.attributionId}"`);
      }
      if (row.status === 'attributed') {
        // Idempotent retry (P0, 2026-09-27): concurrent won events share one
        // introduction via the 0034 backstop, so both report the contract.
        // The same contract reported twice returns the existing record;
        // different details on an already-attributed introduction is a
        // genuine conflict, not a retry.
        if (sameContractDetails(row, input)) return toRecord(row);
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Attribution "${input.attributionId}" is already attributed with different contract details`,
        );
      }
      if (TERMINAL_STATUSES.has(row.status as AttributionStatus)) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Attribution "${input.attributionId}" is already ${row.status} and cannot transition`,
        );
      }
      const record = toRecord(row);
      if (
        !isWithinAttributionWindow(
          record.introducedAt,
          input.contractSignedAt,
          billing.attributionWindowDays,
        )
      ) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Contract signed ${input.contractSignedAt.toISOString()} is outside the ` +
            `${billing.attributionWindowDays}-day attribution window for introduction "${input.attributionId}"`,
        );
      }
      const reportedAt = input.reportedAt ?? now();
      // Conditional UPDATE: a concurrent report that landed first wins;
      // the loser re-reads and applies the idempotency rule on the final
      // state instead of 409ing or silently overwriting.
      const [updated] = await db
        .update(attributionEvents)
        .set({
          contractValueCents: input.contractValueCents,
          contractSignedAt: input.contractSignedAt,
          status: 'attributed',
          updatedAt: reportedAt,
        })
        .where(
          and(
            eq(attributionEvents.id, input.attributionId),
            eq(attributionEvents.status, 'introduced'),
          ),
        )
        .returning();
      if (updated !== undefined) return toRecord(updated);
      const final = await db.query.attributionEvents.findFirst({
        where: eq(attributionEvents.id, input.attributionId),
      });
      if (
        final !== undefined &&
        final.status === 'attributed' &&
        sameContractDetails(final, input)
      ) {
        return toRecord(final);
      }
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        `Attribution "${input.attributionId}" changed concurrently (now '${final?.status ?? 'missing'}')`,
      );
    },

    async markExpired(attributionId: string): Promise<AttributionRecord> {
      await requireOpen(attributionId);
      const [updated] = await db
        .update(attributionEvents)
        .set({ status: 'expired', updatedAt: now() })
        .where(eq(attributionEvents.id, attributionId))
        .returning();
      return toRecord(updated);
    },

    async excludePriorRelationship(attributionId: string): Promise<AttributionRecord> {
      await requireOpen(attributionId);
      const [updated] = await db
        .update(attributionEvents)
        .set({ status: 'excluded_prior_relationship', updatedAt: now() })
        .where(eq(attributionEvents.id, attributionId))
        .returning();
      return toRecord(updated);
    },

    async getById(attributionId: string): Promise<AttributionRecord> {
      const row = await db.query.attributionEvents.findFirst({
        where: eq(attributionEvents.id, attributionId),
      });
      if (row === undefined) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, `Attribution not found: "${attributionId}"`);
      }
      return toRecord(row);
    },

    async findOpenByLead(
      leadId: string,
      tenantKey: string,
    ): Promise<AttributionRecord | null> {
      const rows = await db.query.attributionEvents.findMany({
        where: and(
          eq(attributionEvents.leadId, leadId),
          eq(attributionEvents.tenantKey, tenantKey),
          notInArray(attributionEvents.status, [...TERMINAL_STATUSES]),
        ),
        orderBy: [desc(attributionEvents.createdAt)],
        limit: 1,
      });
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    reportingDeadlineFor(record: AttributionRecord): Date | null {
      if (record.contractSignedAt === null) return null;
      return reportingDeadline(record.contractSignedAt, billing.reportingSlaDays);
    },

    attributionDeadlineFor(record: AttributionRecord): Date {
      return attributionDeadline(record.introducedAt, billing.attributionWindowDays);
    },
  };
}
