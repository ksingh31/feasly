/**
 * Builder partner service (#888, partner disclosure from #847).
 *
 * Owner decision 2026-11-15: Feasly discloses which builder companies
 * receive leads from its own site. The partner list is data: admins add,
 * deactivate and reorder partners here, and the public disclosure
 * (`GET /api/v1/partners`) renders whatever is active — no deploy.
 *
 * - Public list: active partners only (filtered in SQL by the store),
 *   display order then name, company name + logo + website + description.
 *   Never contact details, never the builder link.
 * - In-memory cache for the public list (`partners.cacheTtlMs`); any admin
 *   write on this instance invalidates it at once.
 * - Every admin write is audit-logged with ids and changed field NAMES
 *   only (no values — keeps the trail short and free of free text).
 * - No deletes: deactivate (`active: false`) keeps history and the audit
 *   trail meaningful.
 */
import { randomUUID } from 'node:crypto';
import type {
  AdminBuilderPartner,
  BuilderPartner,
  BuilderPartnerCreateBody,
  BuilderPartnerUpdateBody,
} from '@feasly/contracts';
import type { PartnersConfig } from '../config';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import type {
  BuilderPartnerPatch,
  BuilderPartnerRow,
  BuilderPartnerStore,
} from './builder-partners.store';

export interface BuilderPartnersService {
  /** Active partners in display order (public disclosure). Cached. */
  listPublic(): Promise<readonly BuilderPartner[]>;
  /** Every partner, active and inactive (admin console). */
  listAdmin(): Promise<readonly AdminBuilderPartner[]>;
  /** Create a partner. 400 on invalid input. Audit-logged. */
  create(input: BuilderPartnerCreateBody, adminEmail: string): Promise<AdminBuilderPartner>;
  /** Update (incl. deactivate / reorder). 404 when unknown. Audit-logged. */
  update(
    id: string,
    input: BuilderPartnerUpdateBody,
    adminEmail: string,
  ): Promise<AdminBuilderPartner>;
}

export interface BuilderPartnersServiceDeps {
  readonly store: BuilderPartnerStore;
  readonly audit: AdminAuditStore;
  readonly config: PartnersConfig;
  /** Clock seam for cache-expiry tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export const PARTNER_NAME_MAX = 200;
export const PARTNER_URL_MAX = 2000;
export const PARTNER_DESCRIPTION_MAX = 500;
export const PARTNER_DISPLAY_ORDER_MAX = 10_000;

function invalid(message: string): HttpError {
  return new HttpError(400, ErrorCodes.VALIDATION_FAILED, message, false);
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('name is required.');
  const name = value.trim();
  if (name.length === 0 || name.length > PARTNER_NAME_MAX) {
    throw invalid(`name must be 1–${PARTNER_NAME_MAX} characters.`);
  }
  return name;
}

/** Optional https URL: '' / null → null. Public links are https only. */
function parseUrl(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid(`${field} must be a URL.`);
  const raw = value.trim();
  if (raw === '') return null;
  if (raw.length > PARTNER_URL_MAX) throw invalid(`${field} is too long.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`${field} must be a valid https URL.`);
  }
  if (url.protocol !== 'https:') throw invalid(`${field} must be an https URL.`);
  return raw;
}

function parseDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid('description must be text.');
  const text = value.trim();
  if (text === '') return null;
  if (text.length > PARTNER_DESCRIPTION_MAX) {
    throw invalid(`description must be at most ${PARTNER_DESCRIPTION_MAX} characters.`);
  }
  return text;
}

function parseDisplayOrder(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > PARTNER_DISPLAY_ORDER_MAX
  ) {
    throw invalid(`displayOrder must be an integer 0–${PARTNER_DISPLAY_ORDER_MAX}.`);
  }
  return value;
}

function parseActive(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid('active must be true or false.');
  return value;
}

export function toPublicPartner(row: BuilderPartnerRow): BuilderPartner {
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logoUrl,
    websiteUrl: row.websiteUrl,
    description: row.description,
  };
}

export function toAdminPartner(row: BuilderPartnerRow): AdminBuilderPartner {
  return {
    ...toPublicPartner(row),
    builderId: row.builderId,
    displayOrder: row.displayOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createBuilderPartnersService(
  deps: BuilderPartnersServiceDeps,
): BuilderPartnersService {
  const { store, audit, config } = deps;
  const now = deps.now ?? Date.now;
  let cache: { readonly value: readonly BuilderPartner[]; readonly expiresAt: number } | null =
    null;

  async function parseBuilderId(value: unknown): Promise<string | null> {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalid('builderId must be a builder id.');
    }
    const id = value.trim();
    if (!(await store.builderExists(id))) throw invalid('builderId is not a known builder.');
    return id;
  }

  return {
    async listPublic() {
      if (cache && cache.expiresAt > now()) return cache.value;
      const rows = await store.listActive();
      const value = rows.map(toPublicPartner);
      if (config.cacheTtlMs > 0) cache = { value, expiresAt: now() + config.cacheTtlMs };
      return value;
    },

    async listAdmin() {
      const rows = await store.listAll();
      return rows.map(toAdminPartner);
    },

    async create(input, adminEmail) {
      const name = parseName(input.name);
      const logoUrl = parseUrl(input.logoUrl, 'logoUrl');
      const websiteUrl = parseUrl(input.websiteUrl, 'websiteUrl');
      const description = parseDescription(input.description);
      const displayOrder =
        input.displayOrder === undefined
          ? Math.min((await store.maxDisplayOrder()) + 1, PARTNER_DISPLAY_ORDER_MAX)
          : parseDisplayOrder(input.displayOrder);
      const active = input.active === undefined ? true : parseActive(input.active);
      const builderId = await parseBuilderId(input.builderId);

      const row = await store.insert({
        id: randomUUID(),
        builderId,
        name,
        logoUrl,
        websiteUrl,
        description,
        displayOrder,
        active,
      });
      cache = null;
      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_partner_created',
        detail: `partnerId=${row.id} active=${row.active} displayOrder=${row.displayOrder}`,
      });
      return toAdminPartner(row);
    },

    async update(id, input, adminEmail) {
      const patch: { -readonly [K in keyof BuilderPartnerPatch]: BuilderPartnerPatch[K] } = {};
      if (input.name !== undefined) patch.name = parseName(input.name);
      if (input.logoUrl !== undefined) patch.logoUrl = parseUrl(input.logoUrl, 'logoUrl');
      if (input.websiteUrl !== undefined) {
        patch.websiteUrl = parseUrl(input.websiteUrl, 'websiteUrl');
      }
      if (input.description !== undefined) {
        patch.description = parseDescription(input.description);
      }
      if (input.displayOrder !== undefined) {
        patch.displayOrder = parseDisplayOrder(input.displayOrder);
      }
      if (input.active !== undefined) patch.active = parseActive(input.active);
      if (input.builderId !== undefined) patch.builderId = await parseBuilderId(input.builderId);

      const current = await store.get(id);
      if (!current) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Partner not found.', false);
      }
      const fields = Object.keys(patch);
      if (fields.length === 0) return toAdminPartner(current);

      const row = await store.update(id, patch);
      if (!row) throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Partner not found.', false);
      cache = null;
      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_partner_updated',
        detail: `partnerId=${row.id} fields=${fields.sort().join(',')}`,
      });
      if (patch.active !== undefined && patch.active !== current.active) {
        await audit.log({
          actorEmail: adminEmail,
          action: row.active ? 'admin_partner_activated' : 'admin_partner_deactivated',
          detail: `partnerId=${row.id}`,
        });
      }
      return toAdminPartner(row);
    },
  };
}
