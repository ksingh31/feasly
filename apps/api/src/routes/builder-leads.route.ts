/**
 * Thin builder leads route (embed/09). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * All endpoints are builder-gated via the session-cookie `BuilderGuard`
 * (embed/09). The guard provides the builder's tenant_key; every read and
 * write is scoped to that tenant.
 *
 * - `GET /api/v1/builder/leads` — tenant-scoped lead list + summary.
 * - `PATCH /api/v1/builder/leads/{id}` — pipeline status transition.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type { BuilderLeadListResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { BuilderGuard } from '../middleware/builder-guard';
import type { BuilderLeadsService } from '../services/builder-leads.service';

export interface BuilderLeadsRouteDeps {
  readonly builderLeads: BuilderLeadsService;
  readonly builderGuard: BuilderGuard;
}

export interface BuilderLeadsRoute {
  /** GET /api/v1/builder/leads */
  list(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderLeadListResponse>;
  /** PATCH /api/v1/builder/leads/{id} */
  updateStatus(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<{ readonly ok: true }>;
}

const leadIdParamSchema = z.string().trim().uuid();

function parseLeadId(id: unknown): string {
  const parsed = leadIdParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid lead id.', false);
  }
  return parsed.data;
}

async function requireBuilderSession(
  builderGuard: BuilderGuard,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ readonly email: string; readonly tenantKey: string }> {
  const session = await builderGuard.getBuilderSession(headers);
  if (!session) {
    throw new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'Builder authentication required.',
      false,
    );
  }
  return session;
}

export function createBuilderLeadsRoute(
  deps: BuilderLeadsRouteDeps,
): BuilderLeadsRoute {
  const { builderLeads, builderGuard } = deps;

  return {
    async list(headers): Promise<BuilderLeadListResponse> {
      const session = await requireBuilderSession(builderGuard, headers);
      return builderLeads.listLeads(session.tenantKey);
    },

    async updateStatus(headers, id, body): Promise<{ readonly ok: true }> {
      const session = await requireBuilderSession(builderGuard, headers);
      const leadId = parseLeadId(id);
      return builderLeads.updateStatus(
        leadId,
        body,
        session.tenantKey,
        session.email,
      );
    },
  };
}
