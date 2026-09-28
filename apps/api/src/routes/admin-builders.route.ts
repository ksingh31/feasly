/**
 * Thin admin builders route (embed/02 admin-UI migration). Routes are
 * adapters, not logic: validate input → call exactly one service method →
 * return the result.
 *
 * All endpoints are admin-gated via the session-cookie `AdminGuard`
 * (admin/01). The guard also provides the admin email for audit rows.
 *
 * - `GET /api/v1/admin/builders` — list all builders.
 * - `POST /api/v1/admin/builders` — create a builder.
 * - `GET /api/v1/admin/builders/{id}` — one builder.
 * - `PATCH /api/v1/admin/builders/{id}` — update a builder.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  Builder,
  BuilderCreateBody,
  BuilderListResponse,
  BuilderUpdateBody,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BuilderService } from '../services/builder.service';

export interface AdminBuildersRouteDeps {
  readonly builders: BuilderService;
  readonly adminGuard: AdminGuard;
}

export interface AdminBuildersRoute {
  /** GET /api/v1/admin/builders */
  list(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderListResponse>;
  /** POST /api/v1/admin/builders */
  create(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<Builder>;
  /** GET /api/v1/admin/builders/{id} */
  get(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<Builder>;
  /** PATCH /api/v1/admin/builders/{id} */
  update(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<Builder>;
}

const builderIdParamSchema = z.string().trim().uuid();

const TENANT_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const builderStatusSchema = z.enum(['active', 'inactive']);

const builderCreateSchema = z.object({
  tenantKey: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(TENANT_KEY_RE, 'must be lowercase alphanumeric with dashes'),
  businessName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).nullish(),
  phone: z.string().trim().max(50).nullish(),
  logoUrl: z.string().trim().max(2000).nullish(),
  accentColor: z
    .string()
    .trim()
    .regex(HEX_COLOR_RE, 'must be a #rrggbb hex color')
    .nullish(),
  allowedOrigins: z.array(z.string().trim().max(500)).optional(),
  plan: z.string().trim().max(50).nullish(),
  status: builderStatusSchema.nullish(),
  settings: z.record(z.string(), z.unknown()).nullish(),
});

const builderUpdateSchema = z.object({
  businessName: z.string().trim().min(1).max(200).nullish(),
  displayName: z.string().trim().min(1).max(200).nullish(),
  email: z.string().trim().max(320).nullish(),
  phone: z.string().trim().max(50).nullish(),
  logoUrl: z.string().trim().max(2000).nullish(),
  accentColor: z
    .string()
    .trim()
    .regex(HEX_COLOR_RE, 'must be a #rrggbb hex color')
    .nullish(),
  allowedOrigins: z.array(z.string().trim().max(500)).optional(),
  plan: z.string().trim().max(50).nullish(),
  status: builderStatusSchema.nullish(),
  settings: z.record(z.string(), z.unknown()).nullish(),
});

function parseBuilderId(id: unknown): string {
  const parsed = builderIdParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid builder id.', false);
  }
  return parsed.data;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Invalid ${what} body.`,
      false,
    );
  }
  return parsed.data;
}

/**
 * Require admin auth and return the admin's email for audit rows.
 *
 * The session guard validates the cookie; the email comes from the
 * validated session. This keeps the audit trail tied to the authenticated
 * admin. Same pattern as admin-leads.route.ts.
 */
async function requireAdminEmail(
  adminGuard: AdminGuard,
  headers: Record<string, string | string[] | undefined>,
): Promise<string> {
  await adminGuard.requireAdmin(headers);
  const email = await adminGuard.getAdminEmail(headers);
  // requireAdmin passed, so the email must be present. The fallback is
  // defensive — it should never trigger.
  return email ?? 'admin@session';
}

export function createAdminBuildersRoute(
  deps: AdminBuildersRouteDeps,
): AdminBuildersRoute {
  const { builders, adminGuard } = deps;

  const toCreateBody = (data: z.infer<typeof builderCreateSchema>): BuilderCreateBody => ({
    tenantKey: data.tenantKey,
    businessName: data.businessName,
    displayName: data.displayName,
    email: data.email ?? null,
    phone: data.phone ?? null,
    logoUrl: data.logoUrl ?? null,
    accentColor: data.accentColor ?? null,
    allowedOrigins: data.allowedOrigins ?? [],
    plan: data.plan ?? null,
    status: data.status ?? 'active',
    settings: data.settings ?? {},
  });

  const toUpdateBody = (
    data: z.infer<typeof builderUpdateSchema>,
  ): BuilderUpdateBody => ({
    ...(data.businessName !== undefined && data.businessName !== null
      ? { businessName: data.businessName }
      : {}),
    ...(data.displayName !== undefined && data.displayName !== null
      ? { displayName: data.displayName }
      : {}),
    ...(data.email !== undefined ? { email: data.email } : {}),
    ...(data.phone !== undefined ? { phone: data.phone } : {}),
    ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl } : {}),
    ...(data.accentColor !== undefined ? { accentColor: data.accentColor } : {}),
    ...(data.allowedOrigins !== undefined
      ? { allowedOrigins: data.allowedOrigins }
      : {}),
    ...(data.plan !== undefined ? { plan: data.plan } : {}),
    ...(data.status !== undefined && data.status !== null
      ? { status: data.status }
      : {}),
    ...(data.settings !== undefined && data.settings !== null
      ? { settings: data.settings }
      : {}),
  });

  return {
    async list(headers): Promise<BuilderListResponse> {
      await requireAdminEmail(adminGuard, headers);
      const rows = await builders.listBuilders();
      return { builders: rows };
    },

    async create(headers, body): Promise<Builder> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      const data = parseBody(builderCreateSchema, body, 'builder');
      return builders.createBuilder(toCreateBody(data), adminEmail);
    },

    async get(headers, id): Promise<Builder> {
      await requireAdminEmail(adminGuard, headers);
      return builders.getBuilder(parseBuilderId(id));
    },

    async update(headers, id, body): Promise<Builder> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      const data = parseBody(builderUpdateSchema, body, 'builder');
      return builders.updateBuilder(parseBuilderId(id), toUpdateBody(data), adminEmail);
    },
  };
}
