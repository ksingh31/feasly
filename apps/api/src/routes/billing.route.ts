/**
 * Thin billing route (billing/01 first charge path). Routes are adapters,
 * not logic: validate input → require auth → call exactly one service
 * method → return the result.
 *
 * - `POST /api/v1/billing/report-contract` — builder reports the signed
 *   contract for one of their leads (won-without-details retry path, or a
 *   standalone report). Builder-gated; tenant-scoped.
 * - `POST /api/v1/billing/setup-intent` — builder creates a SetupIntent to
 *   save a card on file (commission model). Builder-gated; tenant-scoped.
 * - `GET /api/v1/billing/card` — builder reads their card-on-file status
 *   (brand/last4/expiry only, never the PAN). Builder-gated; tenant-scoped.
 * - `GET /api/v1/billing/invoices/{id}` — read a commission invoice.
 *   Builders see only their own tenant's invoices; admins see all.
 * - `POST /api/v1/billing/invoices/{id}/dispute` — builder disputes their
 *   own invoice (charge clock freezes, ops alerted). Builder-gated.
 * - `POST /api/v1/billing/invoices/{id}/resolve` — admin resolves a
 *   dispute (resume with a fresh review window, or void). Admin-gated.
 * - `GET /api/v1/billing/commission-rate` — builder reads their org's
 *   negotiated commission rate (percent) for the "Record signed contract"
 *   live preview. Builder-gated; tenant-scoped.
 * - `GET /api/v1/billing/payment-method` — builder reads their org's
 *   default payment method (billing/12). Builder-gated; tenant-scoped.
 * - `PUT /api/v1/billing/payment-method` — builder sets their org's
 *   default payment method (billing/12). Applies to future invoices.
 *   Builder-gated; tenant-scoped.
 * - `PUT /api/v1/billing/invoices/{id}/payment-method` — builder changes
 *   the payment method on one of their invoices (billing/12). Unpaid
 *   invoices only; choosing a manual method pauses the Stripe auto-charge.
 *   Builder-gated; tenant-scoped (403 for another tenant's invoice).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BuilderGuard } from '../middleware/builder-guard';
import type {
  BillableEventResult,
} from '../services/billing/embed-billing-hook.service';
import type {
  BillingService,
  ReportContractInput,
} from '../services/billing/billing.service';
import type {
  CommissionCardService,
  CommissionCardStatus,
} from '../services/billing/commission-card.service';
import type { CommissionInvoiceRecord } from '../services/billing/commission.service';
import type { CommissionRateResponse } from '@feasly/contracts';
import type {
  DefaultPaymentMethodResponse,
  SetDefaultPaymentMethodResponse,
} from '@feasly/contracts';

export interface BillingRouteDeps {
  readonly billing: BillingService;
  readonly commissionCard: CommissionCardService;
  readonly builderGuard: BuilderGuard;
  readonly adminGuard: AdminGuard;
}

export interface BillingRoute {
  /** POST /api/v1/billing/report-contract */
  reportContract(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<BillableEventResult>;
  /** POST /api/v1/billing/setup-intent */
  createSetupIntent(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ setupIntentId: string; clientSecret: string }>;
  /** GET /api/v1/billing/card */
  getCard(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<CommissionCardStatus>;
  /** GET /api/v1/billing/invoices/{id} */
  getInvoice(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<CommissionInvoiceRecord>;
  /** GET /api/v1/billing/invoices — paginated, tenant-scoped list */
  listInvoices(
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string | string[] | undefined>,
  ): Promise<CommissionInvoiceRecord[]>;
  /** POST /api/v1/billing/invoices/{id}/dispute */
  disputeInvoice(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<CommissionInvoiceRecord>;
  /** POST /api/v1/billing/invoices/{id}/resolve */
  resolveDispute(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<CommissionInvoiceRecord>;
  /** GET /api/v1/billing/commission-rate */
  getCommissionRate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<CommissionRateResponse>;
  /** GET /api/v1/billing/payment-method */
  getDefaultPaymentMethod(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<DefaultPaymentMethodResponse>;
  /** PUT /api/v1/billing/payment-method */
  setDefaultPaymentMethod(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<SetDefaultPaymentMethodResponse>;
  /** PUT /api/v1/billing/invoices/{id}/payment-method */
  setInvoicePaymentMethod(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<CommissionInvoiceRecord>;
}

const uuidSchema = z.string().trim().uuid();

const listInvoicesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const reportContractBodySchema = z.object({
  leadId: uuidSchema,
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  contractValueCents: z.number().int().positive(),
  contractSignedAt: z.string().datetime({ offset: true }),
});

const disputeBodySchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

const resolveBodySchema = z.object({
  outcome: z.enum(['resume', 'void']),
});

const paymentMethodBodySchema = z.object({
  method: z.enum(['card', 'cheque', 'e_transfer', 'bank_draft']),
});

function parseInvoiceId(id: unknown): string {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'Invalid invoice id.',
      false,
    );
  }
  return parsed.data;
}

/** First value of a query param (Azure passes string|string[]). */
function firstQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
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

export function createBillingRoute(deps: BillingRouteDeps): BillingRoute {
  const { billing, commissionCard, builderGuard, adminGuard } = deps;

  return {
    async reportContract(headers, body): Promise<BillableEventResult> {
      const session = await requireBuilderSession(builderGuard, headers);
      const parsed = reportContractBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid contract report body.',
          false,
        );
      }
      const input: ReportContractInput = {
        tenantKey: session.tenantKey,
        leadId: parsed.data.leadId,
        contractValueCents: parsed.data.contractValueCents,
        contractSignedAt: new Date(parsed.data.contractSignedAt),
      };
      return billing.reportContract(input);
    },

    async getCard(
      headers: Record<string, string | string[] | undefined>,
    ): Promise<CommissionCardStatus> {
      const session = await requireBuilderSession(builderGuard, headers);
      return commissionCard.getCard(session.tenantKey);
    },

    async getCommissionRate(
      headers: Record<string, string | string[] | undefined>,
    ): Promise<CommissionRateResponse> {
      const session = await requireBuilderSession(builderGuard, headers);
      return {
        commissionRatePercent: await billing.getCommissionRatePercent(
          session.tenantKey,
        ),
      };
    },

    async getDefaultPaymentMethod(
      headers: Record<string, string | string[] | undefined>,
    ): Promise<DefaultPaymentMethodResponse> {
      const session = await requireBuilderSession(builderGuard, headers);
      return {
        defaultMethod: await billing.getDefaultPaymentMethod(
          session.tenantKey,
        ),
      };
    },

    async setDefaultPaymentMethod(
      headers: Record<string, string | string[] | undefined>,
      body: unknown,
    ): Promise<SetDefaultPaymentMethodResponse> {
      const session = await requireBuilderSession(builderGuard, headers);
      const parsed = paymentMethodBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid payment method: expected one of card, cheque, e_transfer, bank_draft.',
          false,
        );
      }
      return {
        defaultMethod: await billing.setDefaultPaymentMethod(
          session.tenantKey,
          parsed.data.method,
        ),
      };
    },

    async setInvoicePaymentMethod(
      headers: Record<string, string | string[] | undefined>,
      id: unknown,
      body: unknown,
    ): Promise<CommissionInvoiceRecord> {
      const session = await requireBuilderSession(builderGuard, headers);
      const parsed = paymentMethodBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid payment method: expected one of card, cheque, e_transfer, bank_draft.',
          false,
        );
      }
      return billing.setInvoicePaymentMethod(
        parseInvoiceId(id),
        session.tenantKey,
        parsed.data.method,
      );
    },

    async createSetupIntent(
      headers: Record<string, string | string[] | undefined>,
    ): Promise<{ setupIntentId: string; clientSecret: string }> {
      const session = await requireBuilderSession(builderGuard, headers);
      // Idempotent: ensures the tenant has a Stripe customer first, so the
      // portal needs only one call to start the card form. ensureCustomer
      // throws 503 BILLING_NOT_CONFIGURED when Stripe is not wired; the
      // service converts that to the 422 copy below via its own check.
      await commissionCard.ensureCustomer(session.tenantKey, session.email);
      return commissionCard.createSetupIntent(session.tenantKey);
    },

    async getInvoice(headers, id): Promise<CommissionInvoiceRecord> {
      const invoiceId = parseInvoiceId(id);
      // Admins see all invoices; builders are scoped to their tenant.
      const builderSession = await builderGuard.getBuilderSession(headers);
      if (builderSession) {
        return billing.getInvoice(invoiceId, builderSession.tenantKey);
      }
      await adminGuard.requireAdmin(headers);
      return billing.getInvoice(invoiceId, null);
    },

    async listInvoices(
      headers,
      query,
    ): Promise<CommissionInvoiceRecord[]> {
      const parsed = listInvoicesQuerySchema.safeParse({
        limit: firstQueryValue(query['limit']),
        offset: firstQueryValue(query['offset']),
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid pagination: limit 1–100, offset ≥ 0.',
          false,
        );
      }
      // Admins see all invoices; builders are scoped to their tenant.
      const builderSession = await builderGuard.getBuilderSession(headers);
      if (builderSession) {
        return billing.listInvoices(builderSession.tenantKey, parsed.data);
      }
      await adminGuard.requireAdmin(headers);
      return billing.listInvoices(null, parsed.data);
    },

    async disputeInvoice(
      headers,
      id,
      body,
    ): Promise<CommissionInvoiceRecord> {
      const session = await requireBuilderSession(builderGuard, headers);
      const parsed = disputeBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A dispute reason is required.',
          false,
        );
      }
      return billing.disputeInvoice(
        parseInvoiceId(id),
        session.tenantKey,
        parsed.data.reason,
      );
    },

    async resolveDispute(
      headers,
      id,
      body,
    ): Promise<CommissionInvoiceRecord> {
      await adminGuard.requireAdmin(headers);
      const parsed = resolveBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid resolve body: outcome must be "resume" or "void".',
          false,
        );
      }
      return billing.resolveDispute(parseInvoiceId(id), parsed.data.outcome);
    },
  };
}
