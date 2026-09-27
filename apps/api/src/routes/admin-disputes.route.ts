/**
 * Thin dispute-console route (billing/01 follow-on, was OPS-009). Routes
 * are adapters, not logic: validate input → require admin → call exactly
 * one service method → return the result.
 *
 * - `GET /api/v1/admin/disputes` — open disputes, oldest first, each with
 *   its 5-business-day SLA countdown (America/Edmonton).
 * - `GET /api/v1/admin/disputes/{id}` — dispute detail: immutable evidence
 *   snapshot + audit trail.
 * - `POST /api/v1/admin/disputes/{id}/accept` — accept: void the invoice
 *   (Stripe refund first when it was already paid — the credit note).
 * - `POST /api/v1/admin/disputes/{id}/reject` — reject: invoice back to
 *   in_review with a fresh 7-day window.
 *
 * Accept/reject are both audit-logged server-side. SLA breaches escalate
 * via ops alerts (dispute-sla-timer) and never auto-resolve.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  BillingEvent,
  DisputeDetailResponse,
  DisputeListItem,
  DisputeListResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type {
  BillingAuditRecord,
  DisputeDetailRecord,
  DisputeListItem as ServiceListItem,
  DisputeService,
} from '../services/billing/dispute.service';

export interface AdminDisputesRouteDeps {
  readonly disputes: DisputeService;
  readonly adminGuard: AdminGuard;
}

export interface AdminDisputesRoute {
  /** GET /api/v1/admin/disputes */
  listDisputes(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<DisputeListResponse>;
  /** GET /api/v1/admin/disputes/{id} */
  getDispute(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<DisputeDetailResponse>;
  /** POST /api/v1/admin/disputes/{id}/accept */
  acceptDispute(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<DisputeListItem>;
  /** POST /api/v1/admin/disputes/{id}/reject */
  rejectDispute(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<DisputeListItem>;
}

const uuidSchema = z.string().trim().uuid();

const resolveBodySchema = z.object({
  /** Optional admin note recorded on the dispute + audit trail. */
  note: z.string().trim().max(2000).optional(),
});

function parseDisputeId(id: unknown): string {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'Invalid dispute id.',
      false,
    );
  }
  return parsed.data;
}

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null =>
  date === null ? null : date.toISOString();

function toListItemWire(item: ServiceListItem): DisputeListItem {
  return {
    id: item.id,
    invoiceId: item.invoiceId,
    tenantKey: item.tenantKey,
    reason: item.reason,
    status: item.status,
    openedAt: iso(item.openedAt),
    slaDueAt: iso(item.slaDueAt),
    slaBreachedAt: isoOrNull(item.slaBreachedAt),
    commissionCents: item.evidenceSnapshot.commissionCents,
    currency: item.evidenceSnapshot.currency,
    contractValueCents: item.evidenceSnapshot.contractValueCents,
    businessDaysRemaining: item.businessDaysRemaining,
    breached: item.breached,
  };
}

function toAuditWire(event: BillingAuditRecord): BillingEvent {
  return {
    id: event.id,
    tenantKey: event.tenantKey,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    payload: event.payload,
    createdAt: iso(event.createdAt),
  };
}

function toDetailWire(detail: DisputeDetailRecord): DisputeDetailResponse {
  return {
    ...toListItemWire(detail),
    evidenceSnapshot: {
      ...detail.evidenceSnapshot,
    },
    resolvedAt: isoOrNull(detail.resolvedAt),
    resolvedBy: detail.resolvedBy,
    resolutionNote: detail.resolutionNote,
    auditTrail: detail.auditTrail.map(toAuditWire),
  };
}

export function createAdminDisputesRoute(
  deps: AdminDisputesRouteDeps,
): AdminDisputesRoute {
  const { disputes, adminGuard } = deps;

  async function requireAdminEmail(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<string> {
    await adminGuard.requireAdmin(headers);
    const email = await adminGuard.getAdminEmail(headers);
    // requireAdmin threw unless the session is valid; the email is the
    // audit identity. Fall back defensively — never anonymous.
    return email ?? 'admin';
  }

  return {
    async listDisputes(headers): Promise<DisputeListResponse> {
      await adminGuard.requireAdmin(headers);
      const items = await disputes.listOpenDisputes();
      return { disputes: items.map(toListItemWire) };
    },

    async getDispute(headers, id): Promise<DisputeDetailResponse> {
      await adminGuard.requireAdmin(headers);
      const detail = await disputes.getDisputeDetail(parseDisputeId(id));
      return toDetailWire(detail);
    },

    async acceptDispute(headers, id, body): Promise<DisputeListItem> {
      const adminEmail = await requireAdminEmail(headers);
      const parsed = resolveBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid accept body.',
          false,
        );
      }
      const record = await disputes.acceptDispute(parseDisputeId(id), {
        adminEmail,
        note: parsed.data.note,
      });
      // Fresh countdown fields for the (now resolved) row.
      const detail = await disputes.getDisputeDetail(record.id);
      return toListItemWire(detail);
    },

    async rejectDispute(headers, id, body): Promise<DisputeListItem> {
      const adminEmail = await requireAdminEmail(headers);
      const parsed = resolveBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid reject body.',
          false,
        );
      }
      const record = await disputes.rejectDispute(parseDisputeId(id), {
        adminEmail,
        note: parsed.data.note,
      });
      const detail = await disputes.getDisputeDetail(record.id);
      return toListItemWire(detail);
    },
  };
}
