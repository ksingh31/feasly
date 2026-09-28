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
 * invoices carrying their own tenant key (403 otherwise).
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
}

export interface BillingServiceDeps {
  readonly leadStore: LeadStore;
  readonly billingHook: EmbedBillingHookService;
  readonly commission: CommissionService;
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
  const { leadStore, billingHook, commission, disputes } = deps;

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
      const lead = await leadStore.findById(input.leadId);
      if (lead === undefined || lead === null) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          `Lead not found: "${input.leadId}"`,
        );
      }
      if (lead.tenantKey !== input.tenantKey) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This lead belongs to a different builder.',
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
  };
}
