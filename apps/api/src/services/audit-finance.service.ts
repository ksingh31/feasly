/**
 * Audit viewer, finance exports and builder activity (#728).
 *
 * - `listAudit` — the merged admin + billing audit trail, newest first,
 *   keyset-paginated (never loads the whole table).
 * - `financeSummary` — period totals computed here from stored invoice
 *   amounts (integer cents). The browser never sums money.
 * - `exportInvoices` — one CSV row per invoice for the same period
 *   selection as the summary, so the CSV's totals match the panel to the
 *   cent. Capped: a period with more rows than the cap is refused (422),
 *   never silently truncated. Every export writes an audit row.
 * - `builderActivity` — a builder org's own activity. Owner decision
 *   2026-11-15: builder owner/admins (`builder:activity:team`) see the
 *   whole team; other members see only their own actions.
 *
 * Only this service's store touches the db (layer boundary).
 */
import { z } from 'zod';
import {
  INVOICE_EXPORT_COLUMNS,
  type AuditEntityType,
  type AuditLogEntry,
  type AuditLogListResponse,
  type BuilderActivityEntry,
  type BuilderActivityResponse,
  type FinanceSummary,
  type FinanceSummaryBuilderRow,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { effectiveRatePercent } from '../lib/commission-math';
import { centsToDecimal, csvLine } from '../lib/csv';
import type { AdminAuditStore } from './admin-audit.store';
import type {
  AuditCursorPosition,
  AuditFinanceStore,
  AuditRowFilter,
  InvoiceExportRow,
  RawAuditRow,
} from './audit-finance.store';

export interface AuditFinanceConfig {
  /** Max invoice rows in one CSV export. */
  readonly exportMaxRows: number;
  /** Longest period an export or summary may cover, in days. */
  readonly maxRangeDays: number;
  /** Configured default commission rate as a fraction (legacy invoices). */
  readonly defaultCommissionRate: number;
  /** Currency reported on the summary. */
  readonly currency: string;
}

export interface AuditFinanceServiceDeps {
  readonly store: AuditFinanceStore;
  readonly audit: Pick<AdminAuditStore, 'log'>;
  readonly config: AuditFinanceConfig;
  /** Injected clock (default period = the current calendar month, UTC). */
  readonly now?: () => Date;
}

/** Who is exporting: staff (all tenants) or one builder org. */
export type ExportActor =
  | { readonly kind: 'staff'; readonly email: string }
  | {
      readonly kind: 'builder';
      readonly email: string;
      readonly tenantKey: string;
      readonly builderId: string | null;
    };

export interface BuilderActivityActor {
  readonly email: string;
  readonly tenantKey: string;
  readonly builderId: string | null;
  /** True when the caller holds `builder:activity:team`. */
  readonly team: boolean;
}

export interface AuditFinanceService {
  listAudit(query: Record<string, unknown>): Promise<AuditLogListResponse>;
  financeSummary(query: Record<string, unknown>): Promise<FinanceSummary>;
  exportInvoices(
    query: Record<string, unknown>,
    actor: ExportActor,
  ): Promise<{ readonly csv: string; readonly filename: string }>;
  builderActivity(
    query: Record<string, unknown>,
    actor: BuilderActivityActor,
  ): Promise<BuilderActivityResponse>;
}

/** Admin actions builders never see: staff security/ops internals. */
const BUILDER_HIDDEN_ACTION_PREFIXES = [
  'authz.',
  'auth_failed',
  'builder_leads_cross_builder_denied',
  'admin_leads_',
] as const;

/** Staff-originated actions: builders see them as "Feasly", not an email. */
const STAFF_ACTION_PREFIXES = ['admin_', 'view_as.'] as const;

/**
 * Billing-event payload keys that only ever carry a Feasly staff identity
 * (manual payment / rate change `adminEmail`, dispute `resolvedBy`). Builders
 * never see these keys, and an actor taken from one of them shows as null.
 */
const STAFF_PAYLOAD_KEYS = ['adminEmail', 'resolvedBy'] as const;

/** Builder view of an entry: Feasly staff identities removed. */
function redactStaffForBuilder(
  e: AuditLogEntry,
  callerEmail: string,
): { actorEmail: string | null; payload: AuditLogEntry['payload'] } {
  const caller = callerEmail.toLowerCase();
  if (e.source === 'billing') {
    const payload: Record<string, unknown> | null = e.payload ? { ...e.payload } : null;
    const staff = new Set<string>();
    if (payload) {
      for (const key of STAFF_PAYLOAD_KEYS) {
        const v = payload[key];
        if (typeof v === 'string') staff.add(v.toLowerCase());
        delete payload[key];
      }
    }
    const actor = e.actorEmail?.toLowerCase();
    return {
      actorEmail: actor !== undefined && staff.has(actor) ? null : e.actorEmail,
      payload,
    };
  }
  const staffAction = STAFF_ACTION_PREFIXES.some((p) => e.action.startsWith(p));
  return {
    actorEmail: staffAction && e.actorEmail?.toLowerCase() !== caller ? null : e.actorEmail,
    payload: e.payload,
  };
}

const ENTITY_TYPES = [
  'builder',
  'lead',
  'invoice',
  'user',
  'dispute',
  'api_key',
  'other',
] as const satisfies readonly AuditEntityType[];

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function validation(message: string): HttpError {
  return new HttpError(400, ErrorCodes.VALIDATION_FAILED, message, false);
}

/** ISO date (`2026-11-01`) or date-time with offset. */
const isoInstant = z
  .string()
  .trim()
  .max(40)
  .refine((v) => /^\d{4}-\d{2}-\d{2}($|T)/.test(v) && !Number.isNaN(Date.parse(v)), {
    message: 'Expected an ISO date or date-time.',
  })
  .transform((v) => new Date(v));

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).max(max).optional(),
  );

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalText(200),
});

const auditQuerySchema = pageSchema.extend({
  actor: optionalText(254),
  action: optionalText(100),
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: optionalText(100),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  impersonation: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  source: z.enum(['admin', 'billing']).optional(),
});

const periodSchema = z.object({
  from: isoInstant.optional(),
  to: isoInstant.optional(),
});

const adminExportSchema = periodSchema.extend({
  tenantKey: optionalText(100),
});

function parse<T extends z.ZodTypeAny>(
  schema: T,
  query: Record<string, unknown>,
  message: string,
): z.infer<T> {
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) flat[k] = first(v);
  const parsed = schema.safeParse(flat);
  if (!parsed.success) throw validation(message);
  return parsed.data;
}

function encodeCursor(row: RawAuditRow): string {
  return Buffer.from(`${row.ts}|${row.source}:${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): AuditCursorPosition | undefined {
  if (!cursor) return undefined;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|((?:admin|billing):[0-9a-f-]{36})$/.exec(raw);
  if (!m) throw validation('Invalid cursor.');
  return { ts: m[1]!, key: m[2]! };
}

/** `key=value` pairs from an admin audit row's free-text detail. */
export function parseDetail(detail: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!detail) return out;
  for (const token of detail.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function adminEntity(pairs: Record<string, string>): {
  entityType: AuditEntityType | null;
  entityId: string | null;
} {
  const target = /^(builder|user):(.+)$/.exec(pairs['target'] ?? '');
  if (pairs['invoiceId']) return { entityType: 'invoice', entityId: pairs['invoiceId'] };
  if (pairs['disputeId']) return { entityType: 'dispute', entityId: pairs['disputeId'] };
  if (pairs['leadId']) return { entityType: 'lead', entityId: pairs['leadId'] };
  if (target) return { entityType: target[1] as 'builder' | 'user', entityId: target[2]! };
  if (pairs['builderId']) return { entityType: 'builder', entityId: pairs['builderId'] };
  if (pairs['userId']) return { entityType: 'user', entityId: pairs['userId'] };
  if (pairs['apiKeyId']) return { entityType: 'api_key', entityId: pairs['apiKeyId'] };
  return { entityType: null, entityId: null };
}

function billingEntityType(raw: string | null): AuditEntityType | null {
  switch (raw) {
    case null:
      return null;
    case 'commission_invoice':
      return 'invoice';
    case 'billing_dispute':
      return 'dispute';
    default:
      return 'other';
  }
}

function isImpersonation(action: string, pairs: Record<string, string>): boolean {
  return (
    action.startsWith('view_as.') ||
    action === 'authz.view_as_action' ||
    pairs['view_as'] === '1'
  );
}

export function toAuditEntry(row: RawAuditRow): AuditLogEntry {
  if (row.source === 'admin') {
    const pairs = parseDetail(row.detail);
    const entity = adminEntity(pairs);
    return {
      id: `admin:${row.id}`,
      source: 'admin',
      occurredAt: row.createdAt.toISOString(),
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: entity.entityType,
      entityId: entity.entityId,
      tenantKey: pairs['tenantKey'] ?? null,
      impersonation: isImpersonation(row.action, pairs),
      payload: Object.keys(pairs).length > 0 ? pairs : row.detail ? { detail: row.detail } : null,
    };
  }
  return {
    id: `billing:${row.id}`,
    source: 'billing',
    occurredAt: row.createdAt.toISOString(),
    actorEmail: row.actorEmail,
    action: row.action,
    entityType: billingEntityType(row.entityType),
    entityId: row.entityId,
    tenantKey: row.tenantKey,
    impersonation: false,
    payload: row.payload,
  };
}

/** commission + tax when the expand-step total is missing (legacy rows). */
function invoiceTotalCents(row: InvoiceExportRow): number {
  return row.totalCents ?? row.commissionCents + row.taxCents;
}

/** Voided before any payment: never billed, excluded from every total. */
function isVoidUnpaid(row: InvoiceExportRow): boolean {
  return row.status === 'void' && row.paidAt === null;
}

interface InvoiceTotals {
  invoiceCount: number;
  invoicedCents: number;
  collectedCents: number;
  refundedCents: number;
  outstandingCents: number;
  taxCents: number;
}

function emptyTotals(): InvoiceTotals {
  return {
    invoiceCount: 0,
    invoicedCents: 0,
    collectedCents: 0,
    refundedCents: 0,
    outstandingCents: 0,
    taxCents: 0,
  };
}

function addInvoice(t: InvoiceTotals, row: InvoiceExportRow, refunded: number): void {
  if (isVoidUnpaid(row)) return;
  const total = invoiceTotalCents(row);
  t.invoiceCount += 1;
  t.invoicedCents += total;
  t.taxCents += row.taxCents;
  if (row.paidAt !== null) t.collectedCents += total;
  else t.outstandingCents += total;
  t.refundedCents += refunded;
}

export function createAuditFinanceService(
  deps: AuditFinanceServiceDeps,
): AuditFinanceService {
  const { store, audit, config } = deps;
  const now = deps.now ?? (() => new Date());

  /** [from, to) — defaults to the current calendar month (UTC). */
  function resolvePeriod(from: Date | undefined, to: Date | undefined): { from: Date; to: Date } {
    const n = now();
    const start = from ?? new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
    const end = to ?? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    if (end.getTime() <= start.getTime()) {
      throw validation('The end of the period must be after its start.');
    }
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    if (days > config.maxRangeDays) {
      throw validation(`The period can cover at most ${config.maxRangeDays} days.`);
    }
    return { from: start, to: end };
  }

  /** Invoices for the period plus each one's refunded cents. */
  async function loadInvoices(
    tenantKey: string | null,
    period: { from: Date; to: Date },
  ): Promise<{ rows: readonly InvoiceExportRow[]; refunded: Map<string, number> }> {
    // One extra row tells us the period is over the cap.
    const rows = await store.listInvoicesForExport(
      { tenantKey, from: period.from, to: period.to },
      config.exportMaxRows + 1,
    );
    if (rows.length > config.exportMaxRows) {
      throw new HttpError(
        422,
        ErrorCodes.VALIDATION_FAILED,
        `More than ${config.exportMaxRows} invoices in this period. Choose a shorter date range.`,
        false,
      );
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const refunded = new Map<string, number>();
    for (const ev of await store.listRefunds(rows.map((r) => r.id))) {
      const inv = byId.get(ev.invoiceId);
      if (!inv) continue;
      const total = invoiceTotalCents(inv);
      const amount = ev.amountCents ?? total;
      // A refund can never exceed what was charged.
      refunded.set(ev.invoiceId, Math.min(total, (refunded.get(ev.invoiceId) ?? 0) + amount));
    }
    return { rows, refunded };
  }

  function periodLabel(period: { from: Date; to: Date }): string {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const lastDay = new Date(period.to.getTime() - 1);
    return `${day(period.from)}_${day(lastDay)}`;
  }

  async function listTrail(
    filter: AuditRowFilter,
    limit: number,
  ): Promise<{ rows: readonly RawAuditRow[]; nextCursor: string | null }> {
    const rows = await store.listAuditRows(filter, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  return {
    async listAudit(query) {
      const q = parse(auditQuerySchema, query, 'Invalid audit log query.');
      const filter: AuditRowFilter = {
        actor: q.actor?.toLowerCase(),
        actionPrefix: q.action,
        entityId: q.entityId,
        from: q.from,
        to: q.to,
        impersonationOnly: q.impersonation,
        source: q.source,
        entityType: q.entityType,
        after: decodeCursor(q.cursor),
      };
      const { rows, nextCursor } = await listTrail(filter, q.limit);
      return { items: rows.map(toAuditEntry), nextCursor };
    },

    async financeSummary(query) {
      const q = parse(periodSchema, query, 'Invalid period: use ISO dates for from and to.');
      const period = resolvePeriod(q.from, q.to);
      const { rows, refunded } = await loadInvoices(null, period);
      const totals = emptyTotals();
      const builderTotals = new Map<string, InvoiceTotals & { builderName: string | null }>();
      for (const row of rows) {
        const r = refunded.get(row.id) ?? 0;
        addInvoice(totals, row, r);
        let b = builderTotals.get(row.tenantKey);
        if (!b) {
          b = { ...emptyTotals(), builderName: row.builderName };
          builderTotals.set(row.tenantKey, b);
        }
        addInvoice(b, row, r);
      }
      const byBuilder: FinanceSummaryBuilderRow[] = [...builderTotals.entries()]
        .filter(([, b]) => b.invoiceCount > 0)
        .map(([tenantKey, b]) => ({ tenantKey, ...b }))
        .sort((a, b) => b.invoicedCents - a.invoicedCents || a.tenantKey.localeCompare(b.tenantKey));
      return {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        currency: config.currency,
        ...totals,
        byBuilder,
      };
    },

    async exportInvoices(query, actor) {
      const q =
        actor.kind === 'staff'
          ? parse(adminExportSchema, query, 'Invalid export query.')
          : { ...parse(periodSchema, query, 'Invalid export query.'), tenantKey: undefined };
      const period = resolvePeriod(q.from, q.to);
      // Builders are pinned to their own tenant; a request value is ignored.
      const tenantKey = actor.kind === 'builder' ? actor.tenantKey : (q.tenantKey ?? null);
      const { rows, refunded } = await loadInvoices(tenantKey, period);

      const lines = [INVOICE_EXPORT_COLUMNS.join(',')];
      for (const row of rows) {
        lines.push(
          csvLine([
            row.invoiceNumber,
            row.createdAt.toISOString(),
            row.builderName,
            row.tenantKey,
            row.leadId,
            centsToDecimal(row.contractValueCents),
            effectiveRatePercent(row, config.defaultCommissionRate),
            centsToDecimal(row.commissionCents),
            centsToDecimal(row.taxCents),
            centsToDecimal(invoiceTotalCents(row)),
            row.currency,
            row.status,
            row.manualPaymentMethod ?? row.paymentMethod,
            row.paidAt?.toISOString() ?? null,
            centsToDecimal(refunded.get(row.id) ?? 0),
            row.stripePaymentIntentId,
          ]),
        );
      }

      const label = periodLabel(period);
      await audit.log({
        actorEmail: actor.email,
        action: 'finance.invoices_exported',
        detail:
          actor.kind === 'builder'
            ? `tenantKey=${actor.tenantKey}` +
              (actor.builderId ? ` builderId=${actor.builderId}` : '') +
              ` period=${label} rows=${rows.length}`
            : `scope=${tenantKey ? `tenantKey:${tenantKey}` : 'all'} period=${label} rows=${rows.length}`,
      });

      const prefix = actor.kind === 'builder' ? `invoices-${actor.tenantKey}` : 'invoices';
      return { csv: `${lines.join('\r\n')}\r\n`, filename: `${prefix}-${label}.csv` };
    },

    async builderActivity(query, actor) {
      const q = parse(pageSchema, query, 'Invalid activity query.');
      const builderId = actor.builderId ?? (await store.findBuilderIdByTenant(actor.tenantKey));
      const filter: AuditRowFilter = {
        builder: { tenantKey: actor.tenantKey, builderId },
        excludeActionPrefixes: BUILDER_HIDDEN_ACTION_PREFIXES,
        actor: actor.team ? undefined : actor.email.toLowerCase(),
        after: decodeCursor(q.cursor),
      };
      const { rows, nextCursor } = await listTrail(filter, q.limit);
      const items: BuilderActivityEntry[] = rows.map((row) => {
        const e = toAuditEntry(row);
        // Feasly staff identities are not part of the builder's team.
        const redacted = redactStaffForBuilder(e, actor.email);
        return {
          id: e.id,
          occurredAt: e.occurredAt,
          actorEmail: redacted.actorEmail,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          payload: redacted.payload,
        };
      });
      return { scope: actor.team ? 'team' : 'self', items, nextCursor };
    },
  };
}
