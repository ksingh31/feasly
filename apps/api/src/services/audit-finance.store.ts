/**
 * Drizzle-backed store for the audit viewer, finance exports and builder
 * activity history (#728).
 *
 * Read-only over `admin_audit_log`, `billing_events`, `commission_invoices`
 * and `builders`. Only services import this module (layer boundary:
 * routes and middleware never touch the db directly).
 *
 * Pagination is keyset, newest first, over a `(created_at, id)` cursor.
 * The cursor timestamp is carried at full Postgres precision
 * (microseconds, UTC text) — a JS Date would truncate to milliseconds and
 * skip or repeat rows that share a millisecond.
 */
import { and, asc, desc, eq, gte, inArray, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { AuditEntityType } from '@feasly/contracts';
import type { AppDb } from '../db/client';
import {
  adminAuditLog,
  billingEvents,
  builders,
  commissionInvoices,
} from '../db/schema';

/** Fixed-width UTC timestamp with microseconds — sorts lexicographically. */
const TS_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

/** Keyset position: `ts` from TS_FORMAT, `key` = `${source}:${uuid}`. */
export interface AuditCursorPosition {
  readonly ts: string;
  readonly key: string;
}

export interface RawAuditRow {
  readonly source: 'admin' | 'billing';
  readonly id: string;
  /** Full-precision UTC timestamp (TS_FORMAT). */
  readonly ts: string;
  readonly createdAt: Date;
  readonly actorEmail: string | null;
  readonly action: string;
  /** admin rows: free-text `key=value` detail. */
  readonly detail: string | null;
  /** billing rows only. */
  readonly tenantKey: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Record<string, unknown> | null;
}

export interface AuditRowFilter {
  /** Lower-cased exact actor email. */
  readonly actor?: string;
  /** Action prefix (matched literally). */
  readonly actionPrefix?: string;
  /** Free-text needle the admin detail / billing entity id must contain. */
  readonly entityId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly impersonationOnly?: boolean;
  readonly source?: 'admin' | 'billing';
  /**
   * Derived entity type (see `toAuditEntry`). Applied in SQL before the page
   * limit so a filtered page is never short while more rows exist.
   */
  readonly entityType?: AuditEntityType;
  /**
   * Builder scoping (activity history): admin rows whose detail names this
   * tenant or builder id, and billing rows for this tenant.
   */
  readonly builder?: { readonly tenantKey: string; readonly builderId: string | null };
  /** Admin actions never shown to builders (staff/security internals). */
  readonly excludeActionPrefixes?: readonly string[];
  readonly after?: AuditCursorPosition;
}

export interface InvoiceExportRow {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly createdAt: Date;
  readonly tenantKey: string;
  readonly builderName: string | null;
  readonly leadId: string;
  readonly contractValueCents: number;
  readonly commissionCents: number;
  readonly commissionRateOverride: number | null;
  readonly commissionRatePercent: number | null;
  readonly taxCents: number;
  readonly totalCents: number | null;
  readonly currency: string;
  readonly status: string;
  readonly paymentMethod: string;
  readonly manualPaymentMethod: string | null;
  readonly paidAt: Date | null;
  readonly stripePaymentIntentId: string | null;
}

export interface InvoiceExportFilter {
  /** Null = every tenant (admin). */
  readonly tenantKey: string | null;
  readonly from: Date;
  readonly to: Date;
}

/** A refund recorded against an invoice in `billing_events`. */
export interface InvoiceRefundEvent {
  readonly invoiceId: string;
  /** Explicit refunded amount when the event carries one, else null (= full total). */
  readonly amountCents: number | null;
}

export interface AuditFinanceStore {
  /** Up to `limit` rows of the merged trail after `filter.after`, newest first. */
  listAuditRows(filter: AuditRowFilter, limit: number): Promise<readonly RawAuditRow[]>;
  /** Invoices created in [from, to), oldest first, at most `limit` rows. */
  listInvoicesForExport(
    filter: InvoiceExportFilter,
    limit: number,
  ): Promise<readonly InvoiceExportRow[]>;
  /** Refund events for the given invoices. */
  listRefunds(invoiceIds: readonly string[]): Promise<readonly InvoiceRefundEvent[]>;
  /** Builder id for a tenant key (activity scoping), or null. */
  findBuilderIdByTenant(tenantKey: string): Promise<string | null>;
}

export interface DrizzleAuditFinanceStoreDeps {
  readonly db: AppDb;
}

/** Escape LIKE metacharacters so user input matches literally. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Escape a value for use inside a POSIX regex. */
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Billing `entity_type` values with a dedicated audit entity type. */
const BILLING_ENTITY_TYPES: Partial<Record<AuditEntityType, string>> = {
  invoice: 'commission_invoice',
  dispute: 'billing_dispute',
};

/**
 * SQL mirror of the service's `adminEntity` precedence over the free-text
 * `key=value` detail: invoiceId > disputeId > leadId > target=builder:/user:
 * > builderId > userId > apiKeyId. Null = the type never derives from an
 * admin row.
 */
function adminEntityTypePredicate(detail: SQL, type: AuditEntityType): SQL | null {
  const has = (key: string): SQL => sql`${detail} ~ ${`(^|\\s)${key}=\\S`}`;
  const target = (kind: 'builder' | 'user'): SQL =>
    sql`${detail} ~ ${`(^|\\s)target=${kind}:\\S`}`;
  const not = (p: SQL): SQL => sql`not (${p})`;
  const inv = has('invoiceId');
  const disp = has('disputeId');
  const lead = has('leadId');
  const tBuilder = target('builder');
  const tUser = target('user');
  const anyTarget = or(tBuilder, tUser) as SQL;
  const builderId = has('builderId');
  const userId = has('userId');
  const before = (...ps: SQL[]): SQL[] => ps.map(not);
  switch (type) {
    case 'invoice':
      return inv;
    case 'dispute':
      return and(disp, ...before(inv)) as SQL;
    case 'lead':
      return and(lead, ...before(inv, disp)) as SQL;
    case 'builder':
      return and(
        ...before(inv, disp, lead),
        or(tBuilder, and(not(anyTarget), builderId)) as SQL,
      ) as SQL;
    case 'user':
      return and(
        ...before(inv, disp, lead),
        or(tUser, and(not(anyTarget), not(builderId), userId)) as SQL,
      ) as SQL;
    case 'api_key':
      return and(
        ...before(inv, disp, lead, anyTarget, builderId, userId),
        has('apiKeyId'),
      ) as SQL;
    default:
      return null;
  }
}

/** The actor of a billing event: whichever identity its payload recorded. */
const billingActor = sql<string | null>`coalesce(
  ${billingEvents.payload}->>'adminEmail',
  ${billingEvents.payload}->>'actorEmail',
  ${billingEvents.payload}->>'resolvedBy',
  ${billingEvents.payload}->>'builderEmail'
)`;

export function createDrizzleAuditFinanceStore(
  deps: DrizzleAuditFinanceStoreDeps,
): AuditFinanceStore {
  const { db } = deps;

  async function adminRows(
    filter: AuditRowFilter,
    limit: number,
  ): Promise<RawAuditRow[]> {
    const ts = sql<string>`to_char(${adminAuditLog.createdAt} at time zone 'UTC', ${TS_FORMAT})`;
    const key = sql<string>`'admin:' || ${adminAuditLog.id}::text`;
    const where: SQL[] = [];
    if (filter.actor) {
      where.push(sql`lower(${adminAuditLog.actorEmail}) = ${filter.actor}`);
    }
    if (filter.actionPrefix) {
      where.push(sql`${adminAuditLog.action} like ${`${likeLiteral(filter.actionPrefix)}%`}`);
    }
    if (filter.entityId) {
      where.push(sql`${adminAuditLog.detail} like ${`%${likeLiteral(filter.entityId)}%`}`);
    }
    if (filter.from) where.push(gte(adminAuditLog.createdAt, filter.from));
    if (filter.to) where.push(lt(adminAuditLog.createdAt, filter.to));
    if (filter.impersonationOnly) {
      where.push(
        or(
          sql`${adminAuditLog.action} like 'view\\_as.%'`,
          sql`${adminAuditLog.action} = 'authz.view_as_action'`,
        ) as SQL,
      );
    }
    if (filter.builder) {
      const names = [`tenantKey=${regexLiteral(filter.builder.tenantKey)}`];
      if (filter.builder.builderId) {
        const id = regexLiteral(filter.builder.builderId);
        names.push(`builderId=${id}`, `target=builder:${id}`);
      }
      const pattern = `(^|\\s)(${names.join('|')})(\\s|$)`;
      where.push(sql`${adminAuditLog.detail} ~ ${pattern}`);
    }
    if (filter.entityType) {
      const p = adminEntityTypePredicate(sql`${adminAuditLog.detail}`, filter.entityType);
      if (!p) return [];
      where.push(p);
    }
    for (const prefix of filter.excludeActionPrefixes ?? []) {
      where.push(sql`${adminAuditLog.action} not like ${`${likeLiteral(prefix)}%`}`);
    }
    if (filter.after) {
      const at = sql`${filter.after.ts}::timestamptz`;
      where.push(
        or(
          sql`${adminAuditLog.createdAt} < ${at}`,
          and(sql`${adminAuditLog.createdAt} = ${at}`, sql`${key} < ${filter.after.key}`),
        ) as SQL,
      );
    }
    const rows = await db
      .select({
        id: adminAuditLog.id,
        ts,
        createdAt: adminAuditLog.createdAt,
        actorEmail: adminAuditLog.actorEmail,
        action: adminAuditLog.action,
        detail: adminAuditLog.detail,
      })
      .from(adminAuditLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
      .limit(limit);
    return rows.map((r) => ({
      source: 'admin' as const,
      id: r.id,
      ts: r.ts,
      createdAt: r.createdAt,
      actorEmail: r.actorEmail,
      action: r.action,
      detail: r.detail,
      tenantKey: null,
      entityType: null,
      entityId: null,
      payload: null,
    }));
  }

  async function billingRows(
    filter: AuditRowFilter,
    limit: number,
  ): Promise<RawAuditRow[]> {
    // Billing events are never impersonation activity.
    if (filter.impersonationOnly) return [];
    const ts = sql<string>`to_char(${billingEvents.createdAt} at time zone 'UTC', ${TS_FORMAT})`;
    const key = sql<string>`'billing:' || ${billingEvents.id}::text`;
    const where: SQL[] = [];
    if (filter.actor) where.push(sql`lower(${billingActor}) = ${filter.actor}`);
    if (filter.actionPrefix) {
      where.push(sql`${billingEvents.eventType} like ${`${likeLiteral(filter.actionPrefix)}%`}`);
    }
    if (filter.entityId) where.push(eq(billingEvents.entityId, filter.entityId));
    if (filter.from) where.push(gte(billingEvents.createdAt, filter.from));
    if (filter.to) where.push(lt(billingEvents.createdAt, filter.to));
    if (filter.builder) where.push(eq(billingEvents.tenantKey, filter.builder.tenantKey));
    if (filter.entityType) {
      const mapped = BILLING_ENTITY_TYPES[filter.entityType];
      if (mapped) where.push(eq(billingEvents.entityType, mapped));
      else if (filter.entityType === 'other') {
        where.push(notInArray(billingEvents.entityType, Object.values(BILLING_ENTITY_TYPES)));
      } else return [];
    }
    if (filter.after) {
      const at = sql`${filter.after.ts}::timestamptz`;
      where.push(
        or(
          sql`${billingEvents.createdAt} < ${at}`,
          and(sql`${billingEvents.createdAt} = ${at}`, sql`${key} < ${filter.after.key}`),
        ) as SQL,
      );
    }
    const rows = await db
      .select({
        id: billingEvents.id,
        ts,
        createdAt: billingEvents.createdAt,
        actorEmail: billingActor,
        action: billingEvents.eventType,
        tenantKey: billingEvents.tenantKey,
        entityType: billingEvents.entityType,
        entityId: billingEvents.entityId,
        payload: billingEvents.payload,
      })
      .from(billingEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(billingEvents.createdAt), desc(billingEvents.id))
      .limit(limit);
    return rows.map((r) => ({
      source: 'billing' as const,
      id: r.id,
      ts: r.ts,
      createdAt: r.createdAt,
      actorEmail: r.actorEmail ?? null,
      action: r.action,
      detail: null,
      tenantKey: r.tenantKey,
      entityType: r.entityType,
      entityId: r.entityId,
      payload: (r.payload as Record<string, unknown> | null) ?? null,
    }));
  }

  return {
    async listAuditRows(filter, limit) {
      const [a, b] = await Promise.all([
        filter.source === 'billing' ? [] : adminRows(filter, limit),
        filter.source === 'admin' ? [] : billingRows(filter, limit),
      ]);
      // Each source returned its own newest `limit` rows after the cursor,
      // so the merged newest `limit` is exact — no row can be skipped.
      return [...a, ...b]
        .sort((x, y) => {
          if (x.ts !== y.ts) return x.ts < y.ts ? 1 : -1;
          const kx = `${x.source}:${x.id}`;
          const ky = `${y.source}:${y.id}`;
          return kx < ky ? 1 : kx > ky ? -1 : 0;
        })
        .slice(0, limit);
    },

    async listInvoicesForExport(filter, limit) {
      const where: SQL[] = [
        gte(commissionInvoices.createdAt, filter.from),
        lt(commissionInvoices.createdAt, filter.to),
      ];
      if (filter.tenantKey !== null) {
        where.push(eq(commissionInvoices.tenantKey, filter.tenantKey));
      }
      const rows = await db
        .select({
          id: commissionInvoices.id,
          invoiceNumber: commissionInvoices.invoiceNumber,
          createdAt: commissionInvoices.createdAt,
          tenantKey: commissionInvoices.tenantKey,
          builderName: builders.businessName,
          leadId: commissionInvoices.leadId,
          contractValueCents: commissionInvoices.contractValueCents,
          commissionCents: commissionInvoices.commissionCents,
          commissionRateOverride: commissionInvoices.commissionRateOverride,
          commissionRatePercent: commissionInvoices.commissionRatePercent,
          taxCents: commissionInvoices.taxCents,
          totalCents: commissionInvoices.totalCents,
          currency: commissionInvoices.currency,
          status: commissionInvoices.status,
          paymentMethod: commissionInvoices.paymentMethod,
          manualPaymentMethod: commissionInvoices.manualPaymentMethod,
          paidAt: commissionInvoices.paidAt,
          stripePaymentIntentId: commissionInvoices.stripePaymentIntentId,
        })
        .from(commissionInvoices)
        .leftJoin(builders, eq(builders.tenantKey, commissionInvoices.tenantKey))
        .where(and(...where))
        .orderBy(asc(commissionInvoices.createdAt), asc(commissionInvoices.invoiceNumber))
        .limit(limit);
      return rows.map((r) => ({ ...r, builderName: r.builderName ?? null }));
    },

    async listRefunds(invoiceIds) {
      if (invoiceIds.length === 0) return [];
      const rows = await db
        .select({ entityId: billingEvents.entityId, payload: billingEvents.payload })
        .from(billingEvents)
        .where(
          and(
            eq(billingEvents.entityType, 'commission_invoice'),
            inArray(billingEvents.entityId, [...invoiceIds]),
            or(
              sql`${billingEvents.payload}->>'creditNote' = 'stripe_refund'`,
              eq(billingEvents.eventType, 'invoice.refunded'),
            ),
          ),
        );
      return rows.map((r) => {
        const payload = (r.payload as Record<string, unknown> | null) ?? {};
        const amount = payload['refundedCents'] ?? payload['amountCents'];
        return {
          invoiceId: r.entityId,
          amountCents: typeof amount === 'number' && Number.isInteger(amount) ? amount : null,
        };
      });
    },

    async findBuilderIdByTenant(tenantKey) {
      const rows = await db
        .select({ id: builders.id })
        .from(builders)
        .where(eq(builders.tenantKey, tenantKey))
        .limit(1);
      return rows[0]?.id ?? null;
    },
  };
}
