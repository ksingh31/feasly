/**
 * Thin admin leads-explorer route (admin/02). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * All endpoints are admin-gated via the session-cookie `AdminGuard`
 * (admin/01). The guard also provides the admin email for audit rows.
 *
 * - `GET /api/v1/admin/leads` — filtered list with cursor pagination.
 * - `GET /api/v1/admin/leads/{id}` — full detail with estimate summary.
 * - `POST /api/v1/admin/leads/{id}/notes` — append a note (append-only).
 * - `PATCH /api/v1/admin/leads/{id}/status` — pipeline status transition.
 * - `GET /api/v1/admin/leads/export.csv` — CSV export of the filtered set.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  AdminLeadDetail,
  AdminLeadListResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { AdminLeadsService } from '../services/admin-leads.service';

export interface AdminLeadsRouteDeps {
  readonly adminLeads: AdminLeadsService;
  readonly adminGuard: AdminGuard;
}

export interface AdminLeadsRoute {
  /** GET /api/v1/admin/leads */
  list(
    headers: Record<string, string | string[] | undefined>,
    query: unknown,
  ): Promise<AdminLeadListResponse>;
  /** GET /api/v1/admin/leads/{id} */
  get(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<AdminLeadDetail>;
  /** POST /api/v1/admin/leads/{id}/notes */
  addNote(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<{ readonly ok: true }>;
  /** PATCH /api/v1/admin/leads/{id}/status */
  updateStatus(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<{ readonly ok: true }>;
  /** GET /api/v1/admin/leads/export.csv */
  exportCsv(
    headers: Record<string, string | string[] | undefined>,
    query: unknown,
  ): Promise<{ readonly csv: string; readonly filename: string }>;
}

const leadIdParamSchema = z.string().trim().uuid();

function parseLeadId(id: unknown): string {
  const parsed = leadIdParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid lead id.', false);
  }
  return parsed.data;
}

export function createAdminLeadsRoute(deps: AdminLeadsRouteDeps): AdminLeadsRoute {
  const { adminLeads, adminGuard } = deps;

  return {
    async list(headers, query): Promise<AdminLeadListResponse> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      return adminLeads.listLeads(query, adminEmail);
    },

    async get(headers, id): Promise<AdminLeadDetail> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      return adminLeads.getLead(parseLeadId(id), adminEmail);
    },

    async addNote(headers, id, body): Promise<{ readonly ok: true }> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      return adminLeads.addNote(parseLeadId(id), body, adminEmail);
    },

    async updateStatus(headers, id, body): Promise<{ readonly ok: true }> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      return adminLeads.updateStatus(parseLeadId(id), body, adminEmail);
    },

    async exportCsv(
      headers,
      query,
    ): Promise<{ readonly csv: string; readonly filename: string }> {
      const adminEmail = await requireAdminEmail(adminGuard, headers);
      return adminLeads.exportCsv(query, adminEmail);
    },
  };
}

/**
 * Require admin auth and return the admin's email for audit rows.
 *
 * The session guard validates the cookie; the email comes from the
 * validated session. This keeps the audit trail tied to the authenticated
 * admin (AC4, AC6).
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
