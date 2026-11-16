/**
 * Builder lifecycle (#860): suspend, reactivate, start/complete offboarding,
 * and the admin data export handed to a builder on exit.
 *
 * Owner decisions (2026-11-15, on #860):
 * - A suspended (frozen) builder gets no new leads — they land in the admin
 *   unassigned queue (#721). Unfreezing restores everything.
 * - Commission on leads introduced before offboarding still applies for
 *   the 12-month tail: attribution rows are NEVER touched here, and tail
 *   invoices are collected by invoice with a pay-now link.
 * - Retention: invoices/financial records are kept (6 years, CRA); leads and
 *   other builder data are kept, flagged for review, until #734 lands.
 *   Nothing is deleted by offboarding.
 *
 * Every status change needs a reason, is recorded on the builder row
 * (status_reason / status_changed_at / status_changed_by) and writes an
 * admin audit row naming the acting admin. What each status allows is
 * lib/builder-status-policy.ts.
 *
 * Only services and composition.ts import from src/db/ — enforced by
 * test/boundaries.test.ts. No PII in logs or audit detail (ids only).
 */
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type {
  BuilderExportKind,
  BuilderLifecycleAction,
  BuilderLifecycleResponse,
  BuilderOffboardingBlocker,
  BuilderStatus,
} from '@feasly/contracts';
import type { AppDb } from '../db/client';
import {
  apiKeys,
  billingDisputes,
  builderSessions,
  builders,
  commissionInvoices,
  leads,
} from '../db/schema';
import { ErrorCodes, HttpError } from '../middleware/errors';
import {
  MAX_STATUS_REASON,
  MIN_STATUS_REASON,
  normalizeBuilderStatus,
} from '../lib/builder-status-policy';
import { toCsv } from '../lib/csv';
import type { AdminAuditStore } from './admin-audit.store';
import { toBuilderContract } from './builder.service';

export interface BuilderLifecycleService {
  /**
   * Apply a lifecycle action. 404 unknown builder; 409 when the action is
   * not allowed from the current status; 409 OFFBOARDING_BLOCKED (with the
   * blockers listed) for `complete_offboarding` while an invoice is unpaid
   * or a dispute is open. Re-applying the current status is a no-op
   * (`changed: false`, no audit row).
   */
  changeStatus(
    builderId: string,
    action: BuilderLifecycleAction,
    reason: string,
    adminEmail: string,
  ): Promise<BuilderLifecycleResponse>;
  /** What blocks completing offboarding right now (empty = nothing). */
  offboardingBlockers(builderId: string): Promise<readonly BuilderOffboardingBlocker[]>;
  /** Leads or invoices CSV for one builder (admin hand-over). Audit-logged. */
  exportCsv(
    builderId: string,
    kind: BuilderExportKind,
    adminEmail: string,
  ): Promise<{ readonly csv: string; readonly filename: string }>;
}

export interface BuilderLifecycleServiceDeps {
  readonly db: AppDb;
  readonly audit: Pick<AdminAuditStore, 'log'>;
  /**
   * Detach the builder's saved card (#716). Composition wires the
   * commission-card service; absent (or throwing) = card not detached,
   * reported in the response and logged — offboarding still completes,
   * because the policy already stops every auto-charge for offboarded.
   */
  readonly detachCard?: (tenantKey: string) => Promise<void>;
  /** Called after a status change (e.g. drop API-key auth caches). Never throws. */
  readonly onStatusChanged?: (args: {
    readonly builderId: string;
    readonly tenantKey: string;
    readonly status: BuilderStatus;
  }) => void;
  readonly clock?: () => Date;
  readonly logWarning?: (message: string) => void;
}

/** Invoice statuses that are settled — anything else blocks offboarding. */
const SETTLED_INVOICE_STATUSES: readonly string[] = ['paid', 'void'];

/** Which statuses each action may start from, and where it goes. */
const TRANSITIONS: Readonly<
  Record<
    BuilderLifecycleAction,
    { readonly from: readonly BuilderStatus[]; readonly to: BuilderStatus }
  >
> = {
  suspend: { from: ['active'], to: 'suspended' },
  reactivate: { from: ['suspended', 'offboarding'], to: 'active' },
  start_offboarding: { from: ['active', 'suspended'], to: 'offboarding' },
  complete_offboarding: { from: ['offboarding'], to: 'offboarded' },
};

const AUDIT_ACTIONS: Readonly<Record<BuilderLifecycleAction, string>> = {
  suspend: 'admin_builder_suspended',
  reactivate: 'admin_builder_reactivated',
  start_offboarding: 'admin_builder_offboarding_started',
  complete_offboarding: 'admin_builder_offboarded',
};


export function createBuilderLifecycleService(
  deps: BuilderLifecycleServiceDeps,
): BuilderLifecycleService {
  const { db, audit } = deps;
  const clock = deps.clock ?? (() => new Date());
  const warn = (m: string): void =>
    (deps.logWarning ?? ((msg: string) => console.warn(msg)))(m);

  async function getRow(id: string) {
    const row = await db.query.builders.findFirst({ where: eq(builders.id, id) });
    if (row === undefined) {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.', false);
    }
    return row;
  }

  async function blockersFor(tenantKey: string): Promise<BuilderOffboardingBlocker[]> {
    const invoices = await db
      .select({
        id: commissionInvoices.id,
        invoiceNumber: commissionInvoices.invoiceNumber,
        status: commissionInvoices.status,
      })
      .from(commissionInvoices)
      .where(eq(commissionInvoices.tenantKey, tenantKey));
    const blockers: BuilderOffboardingBlocker[] = invoices
      .filter((i) => !SETTLED_INVOICE_STATUSES.includes(i.status))
      .map((i) => ({
        kind: 'unpaid_invoice' as const,
        invoiceId: i.id,
        invoiceNumber: i.invoiceNumber ?? null,
        status: i.status,
      }));
    const numbers = new Map(invoices.map((i) => [i.id, i.invoiceNumber ?? null]));
    const disputes = await db
      .select({ invoiceId: billingDisputes.invoiceId, status: billingDisputes.status })
      .from(billingDisputes)
      .where(and(eq(billingDisputes.tenantKey, tenantKey), eq(billingDisputes.status, 'open')));
    for (const d of disputes) {
      blockers.push({
        kind: 'open_dispute',
        invoiceId: d.invoiceId,
        invoiceNumber: numbers.get(d.invoiceId) ?? null,
        status: d.status,
      });
    }
    return blockers;
  }

  function describeBlockers(blockers: readonly BuilderOffboardingBlocker[]): string {
    return blockers
      .map((b) =>
        `${b.kind === 'open_dispute' ? 'open dispute on invoice' : 'unpaid invoice'} ` +
        `${b.invoiceNumber ?? b.invoiceId} (${b.status})`,
      )
      .join('; ');
  }

  /** Revoke every portal session and builder-bound API key. */
  async function revokeAccess(
    row: typeof builders.$inferSelect,
    at: Date,
  ): Promise<{ sessionsRevoked: number; apiKeysRevoked: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return db.transaction(async (tx: any) => {
      const sessions = await tx
        .update(builderSessions)
        .set({ revokedAt: at })
        .where(
          and(
            or(
              eq(builderSessions.builderId, row.id),
              eq(builderSessions.tenantKey, row.tenantKey),
            ),
            isNull(builderSessions.revokedAt),
          ),
        )
        .returning({ id: builderSessions.id });
      const keys = await tx
        .update(apiKeys)
        .set({ revokedAt: at })
        .where(and(eq(apiKeys.tenantId, row.tenantKey), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      return { sessionsRevoked: sessions.length, apiKeysRevoked: keys.length };
    });
  }

  async function detachCard(tenantKey: string, builderId: string): Promise<boolean> {
    if (!deps.detachCard) return false;
    try {
      await deps.detachCard(tenantKey);
      return true;
    } catch (error) {
      warn(
        `builder-lifecycle: card detach failed for builderId=${builderId} ` +
          `(${error instanceof Error ? error.message : 'unknown error'})`,
      );
      return false;
    }
  }

  return {
    async changeStatus(builderId, action, reason, adminEmail) {
      const transition = TRANSITIONS[action];
      if (transition === undefined) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Unknown action.', false);
      }
      const trimmed = reason.trim();
      if (trimmed.length < MIN_STATUS_REASON || trimmed.length > MAX_STATUS_REASON) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `A reason of ${MIN_STATUS_REASON}–${MAX_STATUS_REASON} characters is required.`,
          false,
        );
      }
      const current = await getRow(builderId);
      const from = normalizeBuilderStatus(current.status) ?? 'suspended';
      if (from === transition.to) {
        return { builder: toBuilderContract(current), changed: false };
      }
      if (!transition.from.includes(from)) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Can't ${action.replace(/_/g, ' ')} a builder that is ${from}.`,
          false,
        );
      }
      if (action === 'complete_offboarding') {
        const blockers = await blockersFor(current.tenantKey);
        if (blockers.length > 0) {
          throw new HttpError(
            409,
            ErrorCodes.OFFBOARDING_BLOCKED,
            `Offboarding can't be completed yet: ${describeBlockers(blockers)}.`,
            false,
          );
        }
      }
      const at = clock();
      // Compare-and-set on the status read: a concurrent change loses.
      const [updated] = await db
        .update(builders)
        .set({
          status: transition.to,
          statusReason: trimmed,
          statusChangedAt: at,
          statusChangedBy: adminEmail,
          updatedAt: at,
        })
        .where(and(eq(builders.id, builderId), eq(builders.status, current.status)))
        .returning();
      if (!updated) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          'The builder status changed meanwhile. Reload and try again.',
          true,
        );
      }
      let offboarding: BuilderLifecycleResponse['offboarding'];
      if (action === 'complete_offboarding') {
        const revoked = await revokeAccess(updated, at);
        const cardDetached = await detachCard(updated.tenantKey, updated.id);
        offboarding = { ...revoked, cardDetached };
      }
      await audit.log({
        actorEmail: adminEmail,
        action: AUDIT_ACTIONS[action],
        detail:
          `builderId=${updated.id} tenantKey=${updated.tenantKey} from=${from} to=${transition.to}` +
          (offboarding
            ? ` sessionsRevoked=${offboarding.sessionsRevoked} apiKeysRevoked=${offboarding.apiKeysRevoked} cardDetached=${offboarding.cardDetached}`
            : '') +
          ` reason=${JSON.stringify(trimmed)}`,
      });
      try {
        deps.onStatusChanged?.({
          builderId: updated.id,
          tenantKey: updated.tenantKey,
          status: transition.to,
        });
      } catch {
        // Never fails the admin's change.
      }
      return {
        builder: toBuilderContract(updated),
        changed: true,
        ...(offboarding ? { offboarding } : {}),
      };
    },

    async offboardingBlockers(builderId) {
      const row = await getRow(builderId);
      return blockersFor(row.tenantKey);
    },

    async exportCsv(builderId, kind, adminEmail) {
      const row = await getRow(builderId);
      const date = clock().toISOString().slice(0, 10);
      let csv: string;
      let count: number;
      if (kind === 'leads') {
        const rows = await db
          .select({
            id: leads.id,
            createdAt: leads.createdAt,
            name: leads.name,
            email: leads.email,
            phone: leads.phone,
            addressKey: leads.addressKey,
            status: leads.status,
            source: leads.source,
            timeline: leads.timeline,
          })
          .from(leads)
          .where(and(eq(leads.builderId, row.id), eq(leads.sandbox, false)))
          .orderBy(desc(leads.createdAt));
        count = rows.length;
        csv = toCsv(
          ['lead_id', 'created_at', 'name', 'email', 'phone', 'address', 'status', 'source', 'timeline'],
          rows.map((r) => [
            r.id, r.createdAt, r.name, r.email, r.phone, r.addressKey, r.status, r.source, r.timeline,
          ]),
        );
      } else {
        const rows = await db
          .select({
            id: commissionInvoices.id,
            invoiceNumber: commissionInvoices.invoiceNumber,
            leadId: commissionInvoices.leadId,
            status: commissionInvoices.status,
            currency: commissionInvoices.currency,
            contractValueCents: commissionInvoices.contractValueCents,
            commissionCents: commissionInvoices.commissionCents,
            taxCents: commissionInvoices.taxCents,
            totalCents: commissionInvoices.totalCents,
            createdAt: commissionInvoices.createdAt,
            paidAt: commissionInvoices.paidAt,
          })
          .from(commissionInvoices)
          .where(eq(commissionInvoices.tenantKey, row.tenantKey))
          .orderBy(desc(commissionInvoices.createdAt));
        count = rows.length;
        csv = toCsv(
          [
            'invoice_id', 'invoice_number', 'lead_id', 'status', 'currency',
            'contract_value_cents', 'commission_cents', 'tax_cents', 'total_cents',
            'created_at', 'paid_at',
          ],
          rows.map((r) => [
            r.id, r.invoiceNumber, r.leadId, r.status, r.currency,
            r.contractValueCents, r.commissionCents, r.taxCents, r.totalCents,
            r.createdAt, r.paidAt,
          ]),
        );
      }
      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_builder_exported',
        detail: `builderId=${row.id} tenantKey=${row.tenantKey} kind=${kind} rows=${count}`,
      });
      return { csv, filename: `${row.tenantKey}-${kind}-${date}.csv` };
    },
  };
}
