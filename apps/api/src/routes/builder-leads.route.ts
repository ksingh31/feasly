/**
 * Thin builder leads route (embed/09). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * All endpoints are builder-gated via the session-cookie `BuilderGuard`
 * (embed/09). The guard provides the builder's tenant_key; every read and
 * write is scoped to that tenant.
 *
 * - `GET /api/v1/builder/leads` — tenant-scoped lead list + summary.
 * - `GET /api/v1/builder/leads/needs-you` — Leads home "Needs you" groups
 *   + status counts (issue #526).
 * - `PATCH /api/v1/builder/leads/{id}` — pipeline status transition.
 *   Contract details in the body (which create the commission invoice)
 *   additionally require `builder:billing` — recording a contract is
 *   admin-only, whichever endpoint it arrives on (issue #530).
 * - `POST /api/v1/builder/leads/{id}/mark-won` — issue #530: any org
 *   member marks a lead won without recording the contract; org admins
 *   are notified to record it.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  BuilderLeadListResponse,
  BuilderLeadMarkWonResponse,
  BuilderLeadsNeedsYouResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { BuilderGuard } from '../middleware/builder-guard';
import type { PermissionGuard } from '../middleware/permission-guard';
import type {
  BuilderLeadsService,
  WonBillingResult,
} from '../services/builder-leads.service';

export interface BuilderLeadsRouteDeps {
  readonly builderLeads: BuilderLeadsService;
  readonly builderGuard: BuilderGuard;
  /**
   * Issue #530: gates contract details on PATCH behind `builder:billing`
   * (members hold `builder:leads:manage` but must not record contracts).
   */
  readonly permissionGuard: Pick<PermissionGuard, 'requirePermission'>;
}

const STATUS_ROUTE = '/api/v1/builder/leads/{id}';

export interface BuilderLeadsRoute {
  /** GET /api/v1/builder/leads */
  list(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderLeadListResponse>;
  /** GET /api/v1/builder/leads/needs-you */
  needsYou(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderLeadsNeedsYouResponse>;
  /** PATCH /api/v1/builder/leads/{id} */
  updateStatus(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<{ readonly ok: true } & Partial<WonBillingResult>>;
  /** POST /api/v1/builder/leads/{id}/mark-won */
  markWon(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<BuilderLeadMarkWonResponse>;
}

/** True when a PATCH body carries either contract-detail field. */
function hasContractDetails(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return (
    record['contractValueCents'] !== undefined ||
    record['contractSignedAt'] !== undefined
  );
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
  const { builderLeads, builderGuard, permissionGuard } = deps;

  return {
    async list(headers): Promise<BuilderLeadListResponse> {
      const session = await requireBuilderSession(builderGuard, headers);
      return builderLeads.listLeads(session.tenantKey);
    },

    async needsYou(headers): Promise<BuilderLeadsNeedsYouResponse> {
      const session = await requireBuilderSession(builderGuard, headers);
      return builderLeads.getNeedsYou(session.tenantKey);
    },

    async updateStatus(headers, id, body): Promise<{ readonly ok: true }> {
      const session = await requireBuilderSession(builderGuard, headers);
      const leadId = parseLeadId(id);
      if (hasContractDetails(body)) {
        // Recording a contract creates a commission invoice — same gate
        // as POST /api/v1/billing/report-contract (403 + audit for members).
        await permissionGuard.requirePermission(
          'builder:billing',
          headers,
          STATUS_ROUTE,
        );
      }
      return builderLeads.updateStatus(
        leadId,
        body,
        session.tenantKey,
        session.email,
      );
    },

    async markWon(headers, id): Promise<BuilderLeadMarkWonResponse> {
      const session = await requireBuilderSession(builderGuard, headers);
      const leadId = parseLeadId(id);
      return builderLeads.markWon(leadId, session.tenantKey, session.email);
    },
  };
}
