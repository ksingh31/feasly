/**
 * Builder management service (embed/02 admin-UI migration).
 *
 * The `builders` table is the runtime source of truth for builder config,
 * replacing the hardcoded repo-JSON files (`config/builders/*.json`).
 * `tenant_key` is the builder ID used everywhere: embed config, builder
 * sessions, and the billing/attribution joins.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 *
 * No PII in logs: builder contact email/phone never appear in log messages
 * or audit details — only ids and tenant keys.
 */
import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import type {
  Builder,
  BuilderCreateBody,
  BuilderUpdateBody,
  LeadAssignBuilderResponse,
} from '@feasly/contracts';
import type { AppDb } from '../db/client';
import { builders, commissionInvoices, tenants } from '../db/schema';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { isUniqueViolation } from './pg-errors';
import { readDefaultPaymentMethod } from '../lib/payment-method';
import type { AdminAuditStore } from './admin-audit.store';
import {
  createLeadAssignmentService,
  type LeadAssignmentService,
} from './lead-assignment.service';

export interface BuilderService {
  /** All builders, newest first. Admin-only callers. */
  listBuilders(): Promise<readonly Builder[]>;
  /** One builder by id. Throws 404 when missing. */
  getBuilder(id: string): Promise<Builder>;
  /** One builder by tenant key, or null. Used by the portal + embed config. */
  getByTenantKey(tenantKey: string): Promise<Builder | null>;
  /** Create a builder. Throws 409 on duplicate tenant_key. Audit-logged. */
  createBuilder(input: BuilderCreateBody, adminEmail: string): Promise<Builder>;
  /** Update a builder. Throws 404 when missing. Audit-logged. */
  updateBuilder(
    id: string,
    input: BuilderUpdateBody,
    adminEmail: string,
  ): Promise<Builder>;
  /**
   * #870: a builder org owner edits their own profile/branding — the
   * owner-editable subset only (never rate, plan, status, origins).
   * Already-validated input; omitted = unchanged, null clears. Throws 404
   * when missing. Audit-logged under the acting user with the changed
   * field names (never the values).
   */
  updateProfile(
    id: string,
    input: BuilderProfilePatch,
    actorEmail: string,
  ): Promise<Builder>;
  /**
   * Assign (or unassign with null) a lead to a builder. Null builderId is
   * the normal state — the lead flow never depends on it. Throws 404 when
   * the lead (or builder) doesn't exist. Moving a lead away from a builder
   * follows the #721 rules (see lead-assignment.service.ts): 409
   * LEAD_HAS_INVOICE while a non-void invoice exists, otherwise the old
   * attribution closes and the new builder is introduced. Audit-logged.
   */
  assignLead(
    leadId: string,
    builderId: string | null,
    adminEmail: string,
  ): Promise<LeadAssignBuilderResponse>;
  // FUTURE (builder onboarding story): portal-access management hooks in
  // here — list/grant/revoke builder_allowlist emails per builder. The
  // builder_allowlist table and the /builder/login magic-link flow already
  // exist; this is where the admin API will manage them.
}

/** #870: the builder-owner-editable profile fields (validated upstream). */
export interface BuilderProfilePatch {
  readonly displayName?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly logoUrl?: string | null;
  readonly accentColor?: string | null;
}

export interface BuilderServiceDeps {
  readonly db: AppDb;
  readonly audit: AdminAuditStore;
  /** #721 reassignment rules. Defaults to one built from db + audit. */
  readonly leadAssignment?: LeadAssignmentService;
  /**
   * #725: called after an admin assigns a lead to a (different) builder —
   * composition wires the builder-notifications service. Must not throw.
   */
  readonly onLeadAssigned?: (args: {
    readonly leadId: string;
    readonly builderId: string;
  }) => Promise<void>;
  /**
   * #716: called after an update that changed the business name or email,
   * so the builder's Stripe customer stays in sync. Best-effort: a failure
   * is logged and never fails the admin's update.
   */
  readonly onBillingProfileChanged?: (builder: Builder) => Promise<void>;
  /**
   * #870: called after an admin update that changed allowed origins, so
   * builder origin-change requests the update satisfied are closed.
   * Best-effort: a failure is logged and never fails the update.
   */
  readonly onAllowedOriginsChanged?: (args: {
    readonly builderId: string;
    readonly allowedOrigins: readonly string[];
    readonly actorEmail: string;
  }) => Promise<void>;
  /** Warning sink for the best-effort hook. Defaults to console.warn. */
  readonly logWarning?: (message: string) => void;
}

type BuilderRow = typeof builders.$inferSelect;

const BUILDER_STATUS_RE = /^(active|inactive)$/;

/** The default commission rate (percent) — Karan 2026-09-24: 1%. */
const DEFAULT_COMMISSION_RATE_PERCENT = 1;
/** Builder commission rates are negotiated percentages: 0–10. */
const MAX_COMMISSION_RATE_PERCENT = 10;

/**
 * Validate a builder commission rate (percent). 0 is a legitimate
 * negotiated outcome; anything outside 0–10 (or non-numeric) is 400.
 */
function parseCommissionRatePercent(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'commissionRatePercent must be a number.',
      false,
    );
  }
  if (value < 0 || value > MAX_COMMISSION_RATE_PERCENT) {
    throw new HttpError(
      400,
      ErrorCodes.INVALID_RATE,
      `commissionRatePercent must be between 0 and ${MAX_COMMISSION_RATE_PERCENT} (percent).`,
      false,
    );
  }
  return value;
}

function toContract(row: BuilderRow): Builder {
  return {
    id: row.id,
    tenantKey: row.tenantKey,
    businessName: row.businessName,
    displayName: row.displayName,
    email: row.email,
    phone: row.phone,
    logoUrl: row.logoUrl,
    accentColor: row.accentColor,
    allowedOrigins: [...row.allowedOrigins],
    plan: row.plan,
    status: row.status === 'inactive' ? 'inactive' : 'active',
    settings: { ...row.settings },
    commissionRatePercent: row.commissionRatePercent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Mirror a `builders` row into the legacy `tenants` table (#710).
 *
 * Sign-in sessions, the portal allowlist, commission invoices, disputes and
 * the Stripe customer id all hang off `tenants.tenant_key` by foreign key,
 * so a builder without a tenants row cannot sign in, save a card or be
 * invoiced. `builders` is the source of truth: every create/update upserts
 * the shared fields here. `stripe_customer_id` is owned by StripeService and
 * is deliberately never written (an existing id survives every sync).
 *
 * `tenants` columns are NOT NULL where `builders` allows null; '' matches
 * the embed config's own null fallback (builder-config.service.ts).
 */
async function syncTenantRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  row: BuilderRow,
): Promise<void> {
  const shared = {
    businessName: row.businessName,
    displayName: row.displayName,
    logoUrl: row.logoUrl ?? '',
    accentColor: row.accentColor ?? '',
    allowedOrigins: [...row.allowedOrigins],
    fallbackPhone: row.phone ?? '',
    fallbackEmail: row.email ?? '',
    plan: row.plan,
  };
  await tx
    .insert(tenants)
    .values({ tenantKey: row.tenantKey, ...shared })
    .onConflictDoUpdate({ target: tenants.tenantKey, set: shared });
}

function sameOrigins(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((o) => set.has(o));
}

function normalizeOrigins(origins: readonly string[] | undefined): string[] {
  if (origins === undefined) return [];
  return origins.map((o) => o.trim()).filter((o) => o.length > 0);
}

export function createBuilderService(deps: BuilderServiceDeps): BuilderService {
  const { db, audit } = deps;
  const leadAssignment =
    deps.leadAssignment ?? createLeadAssignmentService({ db, audit });

  const warn = (m: string): void =>
    (deps.logWarning ?? ((msg: string) => console.warn(msg)))(m);

  /** Update the row and mirror it into `tenants` in one transaction. */
  async function persistPatch(
    current: BuilderRow,
    patch: Partial<BuilderRow>,
  ): Promise<BuilderRow> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return db.transaction(async (tx: any) => {
      const [updated] = await tx
        .update(builders)
        .set(patch)
        .where(eq(builders.id, current.id))
        .returning();
      if (!updated) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.', false);
      }
      // Keep the shared tenants fields in sync (and create the row for a
      // builder that predates #710 and has not been backfilled yet).
      await syncTenantRow(tx, updated as BuilderRow);
      return updated as BuilderRow;
    });
  }

  /** #716: keep the Stripe customer in sync — best-effort, never throws. */
  async function syncBillingProfile(
    current: BuilderRow,
    row: BuilderRow,
    builder: Builder,
  ): Promise<void> {
    if (
      !deps.onBillingProfileChanged ||
      (row.businessName === current.businessName && row.email === current.email)
    ) {
      return;
    }
    try {
      await deps.onBillingProfileChanged(builder);
    } catch (error) {
      warn(
        `builder-service: Stripe customer sync failed for builderId=${row.id} ` +
          `(${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
  }

  async function getRowById(id: string): Promise<BuilderRow> {
    const row = await db.query.builders.findFirst({
      where: eq(builders.id, id),
    });
    if (row === undefined) {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.', false);
    }
    return row;
  }

  return {
    async listBuilders(): Promise<readonly Builder[]> {
      const rows = await db.query.builders.findMany({
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
      // #873: flag builders with a live bank chargeback (one grouped query).
      const open = await db
        .select({ tenantKey: commissionInvoices.tenantKey, n: count() })
        .from(commissionInvoices)
        .where(eq(commissionInvoices.chargebackStatus, 'open'))
        .groupBy(commissionInvoices.tenantKey);
      const openByTenant = new Map(open.map((r) => [r.tenantKey, Number(r.n)]));
      return rows.map((row) => ({
        ...toContract(row),
        openChargebacks: openByTenant.get(row.tenantKey) ?? 0,
      }));
    },

    async getBuilder(id: string): Promise<Builder> {
      return toContract(await getRowById(id));
    },

    async getByTenantKey(tenantKey: string): Promise<Builder | null> {
      const row = await db.query.builders.findFirst({
        where: eq(builders.tenantKey, tenantKey),
      });
      return row === undefined ? null : toContract(row);
    },

    async createBuilder(
      input: BuilderCreateBody,
      adminEmail: string,
    ): Promise<Builder> {
      const existing = await db.query.builders.findFirst({
        where: eq(builders.tenantKey, input.tenantKey.trim()),
      });
      if (existing !== undefined) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `A builder with tenant key "${input.tenantKey.trim()}" already exists.`,
          false,
        );
      }
      const status = input.status ?? 'active';
      if (!BUILDER_STATUS_RE.test(status)) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'status must be "active" or "inactive".',
          false,
        );
      }
      // Check-then-insert race: the pre-check above catches the common
      // case, but two concurrent creates can both pass it. Map the
      // insert-time unique violation to the same 409 as the pre-check
      // instead of leaking a 500.
      const commissionRatePercent =
        parseCommissionRatePercent(input.commissionRatePercent) ??
        DEFAULT_COMMISSION_RATE_PERCENT;
      let row: BuilderRow | undefined;
      try {
        // One transaction: a builder is never left without its tenants
        // row (#710) — either both rows land or neither does.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        row = await db.transaction(async (tx: any) => {
          const [inserted] = await tx
            .insert(builders)
            .values({
              id: randomUUID(),
              tenantKey: input.tenantKey.trim(),
              businessName: input.businessName.trim(),
              displayName: input.displayName.trim(),
              email: input.email?.trim() || null,
              phone: input.phone?.trim() || null,
              logoUrl: input.logoUrl?.trim() || null,
              accentColor: input.accentColor?.trim() || null,
              allowedOrigins: normalizeOrigins(input.allowedOrigins),
              plan: input.plan?.trim() || null,
              status,
              settings: { ...(input.settings ?? {}) },
              commissionRatePercent,
            })
            .returning();
          if (!inserted) throw new Error('builder insert returned no row');
          await syncTenantRow(tx, inserted as BuilderRow);
          return inserted as BuilderRow;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            `A builder with tenant key "${input.tenantKey.trim()}" already exists.`,
            false,
          );
        }
        throw error;
      }
      if (!row) throw new Error('builder insert returned no row');
      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_builder_created',
        detail: `builderId=${row.id} tenantKey=${row.tenantKey} commissionRatePercent=${row.commissionRatePercent}`,
      });
      return toContract(row);
    },

    async updateBuilder(
      id: string,
      input: BuilderUpdateBody,
      adminEmail: string,
    ): Promise<Builder> {
      const current = await getRowById(id);
      const patch: Partial<BuilderRow> = { updatedAt: new Date() };
      if (input.businessName !== undefined)
        patch.businessName = input.businessName.trim();
      if (input.displayName !== undefined)
        patch.displayName = input.displayName.trim();
      if (input.email !== undefined) patch.email = input.email?.trim() || null;
      if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
      if (input.logoUrl !== undefined)
        patch.logoUrl = input.logoUrl?.trim() || null;
      if (input.accentColor !== undefined)
        patch.accentColor = input.accentColor?.trim() || null;
      if (input.allowedOrigins !== undefined)
        patch.allowedOrigins = normalizeOrigins(input.allowedOrigins);
      if (input.plan !== undefined) patch.plan = input.plan?.trim() || null;
      if (input.status !== undefined) {
        if (!BUILDER_STATUS_RE.test(input.status)) {
          throw new HttpError(
            400,
            ErrorCodes.VALIDATION_FAILED,
            'status must be "active" or "inactive".',
            false,
          );
        }
        patch.status = input.status;
      }
      if (input.settings !== undefined) patch.settings = { ...input.settings };
      const newRatePercent = parseCommissionRatePercent(
        input.commissionRatePercent,
      );
      const rateChanged =
        newRatePercent !== undefined &&
        newRatePercent !== current.commissionRatePercent;
      if (rateChanged) patch.commissionRatePercent = newRatePercent;
      // Default payment method (billing/12): merged into settings JSON so
      // the builder portal's GET /api/v1/billing/payment-method reads the
      // same value the admin set. The dedicated field wins over a stale
      // `defaultPaymentMethod` inside a wholesale settings patch.
      const fromDefaultMethod = readDefaultPaymentMethod(current.settings);
      const methodChanged =
        input.defaultPaymentMethod !== undefined &&
        input.defaultPaymentMethod !== fromDefaultMethod;
      if (methodChanged) {
        patch.settings = {
          ...(patch.settings ?? current.settings),
          defaultPaymentMethod: input.defaultPaymentMethod,
        };
      }
      const row = await persistPatch(current, patch);
      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_builder_updated',
        detail: `builderId=${row.id} tenantKey=${row.tenantKey}`,
      });
      if (rateChanged) {
        await audit.log({
          actorEmail: adminEmail,
          action: 'admin_builder_commission_rate_changed',
          detail:
            `builderId=${row.id} tenantKey=${row.tenantKey} ` +
            `from=${current.commissionRatePercent} to=${newRatePercent}`,
        });
      }
      if (methodChanged) {
        await audit.log({
          actorEmail: adminEmail,
          action: 'admin_builder_default_payment_method_changed',
          detail:
            `builderId=${row.id} tenantKey=${row.tenantKey} ` +
            `from=${fromDefaultMethod} to=${input.defaultPaymentMethod}`,
        });
      }
      const builder = toContract(row);
      await syncBillingProfile(current, row, builder);
      if (
        deps.onAllowedOriginsChanged &&
        input.allowedOrigins !== undefined &&
        !sameOrigins(current.allowedOrigins, row.allowedOrigins)
      ) {
        try {
          await deps.onAllowedOriginsChanged({
            builderId: row.id,
            allowedOrigins: [...row.allowedOrigins],
            actorEmail: adminEmail,
          });
        } catch (error) {
          warn(
            `builder-service: origin-request sync failed for builderId=${row.id} ` +
              `(${error instanceof Error ? error.message : 'unknown error'})`,
          );
        }
      }
      return builder;
    },

    async updateProfile(
      id: string,
      input: BuilderProfilePatch,
      actorEmail: string,
    ): Promise<Builder> {
      const current = await getRowById(id);
      const patch: Partial<BuilderRow> = { updatedAt: new Date() };
      const changed: string[] = [];
      const set = <K extends keyof BuilderProfilePatch & keyof BuilderRow>(
        key: K,
        value: BuilderRow[K],
      ): void => {
        if (value !== current[key]) changed.push(key);
        (patch as Record<string, unknown>)[key] = value;
      };
      if (input.displayName !== undefined) set('displayName', input.displayName);
      if (input.email !== undefined) set('email', input.email);
      if (input.phone !== undefined) set('phone', input.phone);
      if (input.logoUrl !== undefined) set('logoUrl', input.logoUrl);
      if (input.accentColor !== undefined) set('accentColor', input.accentColor);
      const row = await persistPatch(current, patch);
      await audit.log({
        actorEmail,
        action: 'builder_profile_updated',
        detail:
          `builderId=${row.id} tenantKey=${row.tenantKey} ` +
          `fields=${changed.length > 0 ? changed.join(',') : 'none'}`,
      });
      const builder = toContract(row);
      await syncBillingProfile(current, row, builder);
      return builder;
    },

    async assignLead(
      leadId: string,
      builderId: string | null,
      adminEmail: string,
    ): Promise<LeadAssignBuilderResponse> {
      const result = await leadAssignment.assignLead(leadId, builderId, adminEmail);
      // #725: a lead newly assigned to a builder notifies that builder's
      // team once (the outbox dedupes per lead + builder + member). The
      // hook never throws.
      if (builderId !== null && result.changed && deps.onLeadAssigned) {
        await deps.onLeadAssigned({ leadId, builderId });
      }
      return result;
    },
  };
}
