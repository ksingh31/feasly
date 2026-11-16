/**
 * Thin admin builder-partner route (#888). Routes are adapters, not logic:
 * validate input shape → call exactly one service method → return the result.
 *
 * Admin-gated via the session-cookie `AdminGuard` (plus the registry
 * permissions the adapter enforces: builders:read / builders:manage). The
 * guard also provides the admin email for audit rows.
 *
 * - `GET /api/v1/admin/partners` — every partner (active + inactive).
 * - `POST /api/v1/admin/partners` — add a partner.
 * - `PATCH /api/v1/admin/partners/{id}` — edit / deactivate / reorder.
 *
 * Value rules (https URLs, lengths, display-order range, known builder)
 * live in BuilderPartnersService; zod here only checks the shape.
 *
 * Hard rules (enforced by test/boundaries.test.ts): no db/, no process.env,
 * depends on the service interface only.
 */
import { z } from 'zod';
import type {
  AdminBuilderPartner,
  AdminBuilderPartnerListResponse,
  BuilderPartnerCreateBody,
  BuilderPartnerUpdateBody,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BuilderPartnersService } from '../services/builder-partners.service';

export interface AdminPartnersRouteDeps {
  readonly partners: BuilderPartnersService;
  readonly adminGuard: AdminGuard;
}

type Headers = Record<string, string | string[] | undefined>;

export interface AdminPartnersRoute {
  /** GET /api/v1/admin/partners */
  list(headers: Headers): Promise<AdminBuilderPartnerListResponse>;
  /** POST /api/v1/admin/partners */
  create(headers: Headers, body: unknown): Promise<AdminBuilderPartner>;
  /** PATCH /api/v1/admin/partners/{id} */
  update(headers: Headers, id: unknown, body: unknown): Promise<AdminBuilderPartner>;
}

const partnerIdParamSchema = z.string().trim().uuid();

const createSchema = z
  .object({
    name: z.string(),
    logoUrl: z.string().nullish(),
    websiteUrl: z.string().nullish(),
    description: z.string().nullish(),
    builderId: z.string().trim().uuid().nullish(),
    displayOrder: z.number().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().optional(),
    logoUrl: z.string().nullish(),
    websiteUrl: z.string().nullish(),
    description: z.string().nullish(),
    builderId: z.string().trim().uuid().nullish(),
    displayOrder: z.number().optional(),
    active: z.boolean().optional(),
  })
  .strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid partner body.', false);
  }
  return parsed.data;
}

function parsePartnerId(id: unknown): string {
  const parsed = partnerIdParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid partner id.', false);
  }
  return parsed.data;
}

/** Require admin auth and return the admin's email for audit rows. */
async function requireAdminEmail(adminGuard: AdminGuard, headers: Headers): Promise<string> {
  await adminGuard.requireAdmin(headers);
  const email = await adminGuard.getAdminEmail(headers);
  // requireAdmin passed, so the email must be present (defensive fallback).
  return email ?? 'admin@session';
}

export function createAdminPartnersRoute(deps: AdminPartnersRouteDeps): AdminPartnersRoute {
  const { partners, adminGuard } = deps;

  return {
    async list(headers): Promise<AdminBuilderPartnerListResponse> {
      await requireAdminEmail(adminGuard, headers);
      return { partners: await partners.listAdmin() };
    },

    async create(headers, body): Promise<AdminBuilderPartner> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      const data: BuilderPartnerCreateBody = parseBody(createSchema, body);
      return partners.create(data, adminEmail);
    },

    async update(headers, id, body): Promise<AdminBuilderPartner> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      const partnerId = parsePartnerId(id);
      const data: BuilderPartnerUpdateBody = parseBody(updateSchema, body);
      return partners.update(partnerId, data, adminEmail);
    },
  };
}
