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
import { eq } from 'drizzle-orm';
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
  /** Record a lead→builder introduction (opens the attribution window). */
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

function toRecord(row: typeof attributionEvents.$inferSelect): AttributionRecord {
  const status = row.status as AttributionStatus;
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
    },

    async reportContract(input: ReportContractInput): Promise<AttributionRecord> {
      if (!Number.isInteger(input.contractValueCents) || input.contractValueCents <= 0) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          'contractValueCents must be a positive integer (cents, excl. land)',
        );
      }
      const row = await requireOpen(input.attributionId);
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
      const [updated] = await db
        .update(attributionEvents)
        .set({
          contractValueCents: input.contractValueCents,
          contractSignedAt: input.contractSignedAt,
          status: 'attributed',
          updatedAt: reportedAt,
        })
        .where(eq(attributionEvents.id, input.attributionId))
        .returning();
      return toRecord(updated);
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

    reportingDeadlineFor(record: AttributionRecord): Date | null {
      if (record.contractSignedAt === null) return null;
      return reportingDeadline(record.contractSignedAt, billing.reportingSlaDays);
    },

    attributionDeadlineFor(record: AttributionRecord): Date {
      return attributionDeadline(record.introducedAt, billing.attributionWindowDays);
    },
  };
}
