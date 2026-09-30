/**
 * Billing facade (billing/01 first charge path).
 *
 * The single service behind the `/api/v1/billing/*` routes. Orchestrates
 * the billing track's services for the API surface:
 *
 * - `reportContract` — a builder reports the signed contract for one of
 *   their leads (the won-without-details retry path, or a standalone
 *   report). Runs the commission charge path via the billing hook:
 *   attribution → draft invoice → auto-submitted into review.
 * - `getInvoice` — read a commission invoice (tenant-scoped for builders).
 * - `disputeInvoice` — a builder disputes their own invoice: the charge
 *   clock FREEZES and ops is alerted (commission service).
 * - `resolveDispute` — admin resolves a dispute: resume (fresh 7-day
 *   review window) or void.
 *
 * Tenant isolation is enforced at this layer: builders can only touch
 * invoices carrying their own tenant key (403 otherwise), and
 * reportContract scopes the lead by (id, builder_id) resolved from the
 * session's tenant key (403 when the lead belongs to another builder).
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts. This facade never touches db directly; the
 * lead lookup goes through the injected LeadStore.
 */
import type {
  BillableEventResult,
  EmbedBillingHookService,
  LeadWonDetail,
} from './embed-billing-hook.service';
import type {
  CommissionInvoiceRecord,
  CommissionService,
} from './commission.service';
import type { DisputeService } from './dispute.service';
import type { LeadStore } from '../lead.store';
import type { BuilderService } from '../builder.service';
import { ErrorCodes, HttpError } from '../../middleware/errors';

export interface ReportContractInput {
  readonly tenantKey: string;
  readonly leadId: string;
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
  readonly contractSignedAt: Date;
}

export interface BillingService {
  /**
   * Report a signed contract for a builder's lead. Runs the active charge
   * path (commission: attribution → draft invoice → review). Idempotent:
   * re-reporting returns the existing invoice.
   */
  reportContract(input: ReportContractInput): Promise<BillableEventResult>;
  /** Read a commission invoice. Builders are scoped to their tenant. */
  getInvoice(
    invoiceId: string,
    tenantKey: string | null,
  ): Promise<CommissionInvoiceRecord>;
  /**
   * BILL-04: paginated invoice list, newest first. Builders pass their
   * tenantKey (scoped to their own invoices); admins pass null (all).
   */
  listInvoices(
    tenantKey: string | null,
    opts: { limit: number; offset: number },
  ): Promise<CommissionInvoiceRecord[]>;
  /**
   * Dispute an invoice. Builders may only dispute their own tenant's
   * invoices (tenantKey required); admins pass null to skip the check.
   */
  disputeInvoice(
    invoiceId: string,
    tenantKey: string | null,
    reason: string,
  ): Promise<CommissionInvoiceRecord>;
  /** Admin-only: resolve a dispute (resume with fresh review window, or void). */
  resolveDispute(
    invoiceId: string,
    outcome: 'resume' | 'void',
  ): Promise<CommissionInvoiceRecord>;
  /**
   * The builder org's negotiated commission rate, in PERCENT (billing/08).
   * Powers the builder portal's "Record signed contract" live preview.
   */
  getCommissionRatePercent(tenantKey: string): Promise<number>;
}

export interface BillingServiceDeps {
  readonly leadStore: LeadStore;
  readonly billingHook: EmbedBillingHookService;
  readonly commission: CommissionService;
  /**
   * Resolves the session tenant key to the builder row (builders table).
   * Required for reportContract's (id, builder_id) iron-rule scoping —
   * the same pattern as BuilderLeadsService.requireBuilder.
   */
  readonly builders: Pick<BuilderService, 'getByTenantKey'>;
  /**
   * Dispute console (billing/01 follow-on): records the dispute row +
   * immutable evidence snapshot when an invoice is disputed. Optional so
   * existing constructions keep working; composition always wires it.
   */
  readonly disputes?: DisputeService;
}

export function createBillingService(
  deps: BillingServiceDeps,
): BillingService {
  const { leadStore, billingHook, commission, disputes, builders } = deps;

  /**
   * Resolve the session's tenant key to the builder row. Every report
   * call goes through here so a builder always acts as exactly one
   * builder. Unknown (or inactive) tenant key → 404 (no builder to
   * scope to). Matches BuilderLeadsService.requireBuilder.
   */
  async function requireBuilder(tenantKey: string) {
    const builder = await builders.getByTenantKey(tenantKey);
    if (builder === null || builder.status !== 'active') {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.');
    }
    return builder;
  }

  async function requireTenantInvoice(
    invoiceId: string,
    tenantKey: string | null,
  ): Promise<CommissionInvoiceRecord> {
    const invoice = await commission.getById(invoiceId);
    if (tenantKey !== null && invoice.tenantKey !== tenantKey) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'This invoice belongs to a different builder.',
      );
    }
    return invoice;
  }

  return {
    async reportContract(
      input: ReportContractInput,
    ): Promise<BillableEventResult> {
      const builder = await requireBuilder(input.tenantKey);
      // auth/04 (iron rule): the lead is scoped by (id, builder_id)
      // resolved from session state — never by the lead row's tenant_key,
      // which can legitimately diverge (NULL or stale on builder-scoped
      // rows: lead.store insert() defaults tenantKey to null and
      // updateOnRepeat() stamps builderId without touching tenant_key).
      // A cross-builder row is never pulled into the service.
      const lead = await leadStore.findByIdAndBuilderId({
        id: input.leadId,
        builderId: builder.id,
      });
      if (lead === null || lead === undefined) {
        // Distinguish "exists but isn't yours" (403) from "doesn't
        // exist" (404) with a boolean probe — no row data.
        const exists = await leadStore.existsById(input.leadId);
        if (exists) {
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'This lead belongs to a different builder.',
          );
        }
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          `Lead not found: "${input.leadId}"`,
        );
      }
      const detail: LeadWonDetail = {
        leadId: input.leadId,
        introducedAt: lead.createdAt,
        contractValueCents: input.contractValueCents,
        contractSignedAt: input.contractSignedAt,
      };
      return billingHook.recordBillableEvent(
        input.tenantKey,
        'lead_won',
        detail,
      );
    },

    async getInvoice(
      invoiceId: string,
      tenantKey: string | null,
    ): Promise<CommissionInvoiceRecord> {
      return requireTenantInvoice(invoiceId, tenantKey);
    },

    async listInvoices(
      tenantKey: string | null,
      opts: { limit: number; offset: number },
    ): Promise<CommissionInvoiceRecord[]> {
      // Tenant isolation is enforced inside commission.listInvoices:
      // a non-null tenantKey scopes to that tenant's invoices only.
      return commission.listInvoices(tenantKey, opts);
    },

    async disputeInvoice(
      invoiceId: string,
      tenantKey: string | null,
      reason: string,
    ): Promise<CommissionInvoiceRecord> {
      await requireTenantInvoice(invoiceId, tenantKey);
      const invoice = await commission.disputeInvoice(invoiceId, reason);
      // Dispute console: one dispute row per disputed invoice, with the
      // immutable evidence snapshot + 5-business-day SLA.
      if (disputes) {
        await disputes.recordOpenedDispute(invoice);
      }
      return invoice;
    },

    async resolveDispute(
      invoiceId: string,
      outcome: 'resume' | 'void',
    ): Promise<CommissionInvoiceRecord> {
      return commission.resolveDispute(invoiceId, outcome);
    },

    async getCommissionRatePercent(tenantKey: string): Promise<number> {
      return commission.getCommissionRatePercent(tenantKey);
    },
  };
}
