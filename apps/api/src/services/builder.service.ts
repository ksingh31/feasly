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
import { eq } from 'drizzle-orm';
import type {
  Builder,
  BuilderCreateBody,
  BuilderUpdateBody,
} from '@feasly/contracts';
import type { AppDb } from '../db/client';
import { builders, leads } from '../db/schema';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';

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
   * Assign (or unassign with null) a lead to a builder. Null builderId is
   * the normal state — the lead flow never depends on it. Throws 404 when
   * the lead (or builder) doesn't exist. Audit-logged.
   */
  assignLead(
    leadId: string,
    builderId: string | null,
    adminEmail: string,
  ): Promise<{ readonly ok: true }>;
}

export interface BuilderServiceDeps {
  readonly db: AppDb;
  readonly audit: AdminAuditStore;
}

type BuilderRow = typeof builders.$inferSelect;

const BUILDER_STATUS_RE = /^(active|inactive)$/;

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeOrigins(origins: readonly string[] | undefined): string[] {
  if (origins === undefined) return [];
  return origins.map((o) => o.trim()).filter((o) => o.length > 0);
}

export function createBuilderService(deps: BuilderServiceDeps): BuilderService {
  const { db, audit } = deps;

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
      return rows.map(toContract);
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
      const [row] = await db
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
        })
        .returning();
      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_builder_created',
        detail: `builderId=${row.id} tenantKey=${row.tenantKey}`,
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
      const [row] = await db
        .update(builders)
        .set(patch)
        .where(eq(builders.id, current.id))
        .returning();
      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_builder_updated',
        detail: `builderId=${row.id} tenantKey=${row.tenantKey}`,
      });
      return toContract(row);
    },

    async assignLead(
      leadId: string,
      builderId: string | null,
      adminEmail: string,
    ): Promise<{ readonly ok: true }> {
      const lead = await db.query.leads.findFirst({
        where: eq(leads.id, leadId),
      });
      if (lead === undefined) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }
      if (builderId !== null) {
        await getRowById(builderId);
      }
      await db
        .update(leads)
        .set({ builderId })
        .where(eq(leads.id, leadId));
      await audit.log({
        actorEmail: adminEmail,
        action:
          builderId === null
            ? 'admin_lead_builder_unassigned'
            : 'admin_lead_builder_assigned',
        detail: `leadId=${leadId} builderId=${builderId ?? 'null'}`,
      });
      return { ok: true as const };
    },
  };
}
