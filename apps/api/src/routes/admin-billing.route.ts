/**
 * Thin admin billing-health route (billing/03 follow-on — /admin/billing,
 * was OPS-007). Routes are adapters, not logic: validate input → require
 * auth → call exactly one service method → return the result.
 *
 * - `GET /api/v1/admin/billing` — billing-health dashboard payload
 *   (MRR, in-review aging buckets, dunning with `past_due_since`, webhook
 *   health). Admin-gated.
 * - `POST /api/v1/admin/billing/invoices/{id}/retry` — retry a failed
 *   commission charge (BILL-03). Admin-gated, `billing:manage`.
 * - `POST /api/v1/admin/billing/invoices/{id}/mark-paid` — record an
 *   off-Stripe payment (cheque, bank draft, e-transfer, cash, card
 *   terminal, other). Admin-gated, `billing:manage`. Marks the invoice
 *   paid AND cancels the scheduled auto-charge — the builder can never
 *   be double-charged.
 * - `POST /api/v1/admin/billing/invoices/{id}/commission-rate` — override
 *   the per-invoice commission rate (percent). Admin-gated,
 *   `billing:manage`. Unpaid, undisputed invoices only; a disputed or
 *   settled invoice is never silently repriced.
 * - `PUT /api/v1/admin/billing/invoices/{id}/payment-method` — change the
 *   planned payment method on one commission invoice (card, cheque,
 *   e_transfer, bank_draft). Admin-gated, `billing:manage`. Unpaid
 *   invoices only; choosing a manual method pauses the Stripe auto-charge
 *   until staff marks it paid. Audited with the admin identity.
 * - `POST /api/v1/admin/billing/invoices` — manually create a commission
 *   invoice for a builder's converted lead (manual invoicing). Mirrors the
 *   builder-reported contract shape
 *   (`POST /api/v1/billing/report-contract`): leadId (required),
 *   contractValueCents (integer cents, EXCLUDING land), contractSignedAt
 *   (ISO with offset) — plus tenantKey, since the admin picks the builder.
 *   Runs the SAME charge path via `BillingService.reportContract`
 *   (attribution → draft invoice → auto-submitted into the 7-day review
 *   window). Admin-gated, `billing:manage`.
 *
 * - `POST /api/v1/admin/billing/invoices/{id}/refund` (#715) — refund a
 *   paid invoice in full or in part; idempotent on the client key.
 * - `POST /api/v1/admin/billing/invoices/{id}/void` (#715) — cancel a
 *   draft / in_review / failed invoice.
 * - `POST /api/v1/admin/billing/invoices/{id}/correct-contract` (#715) —
 *   fix the reported contract before the invoice is charged.
 * - `POST /api/v1/admin/billing/invoices/{id}/reverse-payment` (#715) —
 *   undo a manual mark-paid (bounced cheque): paid → failed.
 *
 * Every money action is `billing:manage` (central route-permission
 * enforcement: 403 + `authz.denied` audit for other roles) and is audited
 * with the signed-in admin's own email.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  AdminSetInvoicePaymentMethodResponse,
  BillingHealthResponse,
  CorrectContractRequest,
  CorrectContractResponse,
  InvoiceRefund,
  RefundInvoiceRequest,
  RefundInvoiceResponse,
  ReverseManualPaymentRequest,
  ReverseManualPaymentResponse,
  VoidInvoiceRequest,
  VoidInvoiceResponse,
  ManualInvoiceRequest,
  ManualInvoiceResponse,
  ManualPaymentMethod,
  MarkInvoicePaidResponse,
  SetCommissionRateResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { pastOrPresentDatetime } from '../lib/zod-datetime';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BillingHealthService } from '../services/billing/billing-health.service';
import type { BillingService } from '../services/billing/billing.service';
import type {
  CommissionService,
  InvoiceRefundRecord,
} from '../services/billing/commission.service';

const invoiceIdSchema = z.string().trim().uuid();

const MANUAL_PAYMENT_METHODS = [
  'cheque',
  'bank_draft',
  'direct_deposit',
  'e_transfer',
  'cash',
  'visa',
  'mastercard',
  'card_terminal',
  'other',
] as const satisfies ReadonlyArray<ManualPaymentMethod>;

/**
 * QA 2026-10-04 (P5/P6): payment/contract dates record things that already
 * happened, so neither may be in the future. `nowMs` is injected per
 * request — a module-level `Date.now()` would freeze at import time.
 */
const markPaidBodySchema = (nowMs: number) =>
  z.object({
    paymentMethod: z.enum(MANUAL_PAYMENT_METHODS),
    reference: z.string().trim().max(120).optional(),
    paidAt: pastOrPresentDatetime('paidAt', nowMs).optional(),
  });

const setCommissionRateBodySchema = z.object({
  /** Percent, e.g. 1.5 = 1.5%. Must satisfy 0 < rate <= 10. */
  rate: z.number().finite().gt(0).lte(10),
});

/**
 * Planned payment method for one invoice (billing/12) — the same four
 * choices the builder gets. Choosing a manual method pauses the Stripe
 * auto-charge until staff marks the invoice paid.
 */
const plannedPaymentMethodBodySchema = z.object({
  method: z.enum(['card', 'cheque', 'e_transfer', 'bank_draft']),
});

const manualInvoiceBodySchema = (nowMs: number): z.ZodType<ManualInvoiceRequest> =>
  z.object({
    tenantKey: z.string().trim().min(1).max(120),
    leadId: z.string().trim().uuid(),
    /** Signed construction contract value in integer cents, EXCLUDING land. */
    contractValueCents: z.number().int().positive(),
    contractSignedAt: pastOrPresentDatetime('contractSignedAt', nowMs),
  });

const NOTE = z.string().trim().max(500);

/** #715 refund body. `amountCents` omitted = refund the remainder. */
const refundBodySchema: z.ZodType<RefundInvoiceRequest> = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.enum([
    'duplicate',
    'billing_error',
    'deal_fell_through',
    'goodwill',
    'other',
  ]),
  note: NOTE.optional(),
  reference: z.string().trim().max(120).optional(),
  idempotencyKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_:-]{8,100}$/),
});

/** #715 void body. */
const voidBodySchema: z.ZodType<VoidInvoiceRequest> = z.object({
  reason: z.enum(['duplicate', 'created_in_error', 'deal_fell_through', 'other']),
  note: NOTE.optional(),
});

/** #715 contract-correction body — same shape rules as a reported contract. */
const correctContractBodySchema = (
  nowMs: number,
): z.ZodType<CorrectContractRequest> =>
  z.object({
    contractValueCents: z.number().int().positive(),
    contractSignedAt: pastOrPresentDatetime('contractSignedAt', nowMs),
    note: NOTE.min(1),
  });

/** #715 payment-reversal body — the reason is mandatory. */
const reversePaymentBodySchema: z.ZodType<ReverseManualPaymentRequest> =
  z.object({ reason: NOTE.min(1) });

/** Server refund record → wire DTO (ISO dates). */
function toRefundDto(refund: InvoiceRefundRecord): InvoiceRefund {
  return { ...refund, createdAt: refund.createdAt.toISOString() };
}

function invalidBody(message: string): HttpError {
  return new HttpError(400, ErrorCodes.VALIDATION_FAILED, message, false);
}

export interface AdminBillingRouteDeps {
  readonly billingHealth: BillingHealthService;
  readonly commission: CommissionService;
  readonly billing: BillingService;
  readonly adminGuard: AdminGuard;
}

export interface AdminBillingRoute {
  /** GET /api/v1/admin/billing */
  getHealth(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BillingHealthResponse>;
  /** POST /api/v1/admin/billing/invoices/{id}/retry */
  retryCharge(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
  ): Promise<{ invoiceId: string; status: string; retryCount: number }>;
  /** POST /api/v1/admin/billing/invoices/{id}/mark-paid */
  markPaid(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
    body: unknown,
  ): Promise<MarkInvoicePaidResponse>;
  /** POST /api/v1/admin/billing/invoices/{id}/commission-rate */
  setCommissionRate(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
    body: unknown,
  ): Promise<SetCommissionRateResponse>;
  /** PUT /api/v1/admin/billing/invoices/{id}/payment-method */
  setInvoicePaymentMethod(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
    body: unknown,
  ): Promise<AdminSetInvoicePaymentMethodResponse>;
  /** POST /api/v1/admin/billing/invoices */
  createInvoice(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<ManualInvoiceResponse>;
  /** POST /api/v1/admin/billing/invoices/{id}/refund (#715) */
  refundInvoice(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
    body: unknown,
  ): Promise<RefundInvoiceResponse>;
  /** POST /api/v1/admin/billing/invoices/{id}/void (#715) */
  voidInvoice(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
    body: unknown,
  ): Promise<VoidInvoiceResponse>;
  /** POST /api/v1/admin/billing/invoices/{id}/correct-contract (#715) */
  correctContract(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
    body: unknown,
  ): Promise<CorrectContractResponse>;
  /** POST /api/v1/admin/billing/invoices/{id}/reverse-payment (#715) */
  reverseManualPayment(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
    body: unknown,
  ): Promise<ReverseManualPaymentResponse>;
}

export function createAdminBillingRoute(
  deps: AdminBillingRouteDeps,
): AdminBillingRoute {
  const { billingHealth, commission, billing, adminGuard } = deps;

  return {
    async getHealth(headers): Promise<BillingHealthResponse> {
      await adminGuard.requireAdmin(headers);
      return billingHealth.getHealth();
    },

    async retryCharge(headers, invoiceId) {
      await adminGuard.requireAdmin(headers);
      const invoice = await commission.retryCharge(
        invoiceIdSchema.parse(invoiceId),
      );
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        retryCount: invoice.retryCount,
      };
    },

    async markPaid(
      headers,
      invoiceId,
      body,
    ): Promise<MarkInvoicePaidResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = markPaidBodySchema(Date.now()).safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid payment body: paymentMethod (cheque | bank_draft | ' +
            'e_transfer | cash | card_terminal | other), optional reference ' +
            '(max 120 chars), and optional paidAt (ISO datetime with ' +
            'timezone offset, not in the future) are accepted.',
          false,
        );
      }
      const invoice = await commission.markPaidManually(
        invoiceIdSchema.parse(invoiceId),
        {
          paymentMethod: parsed.data.paymentMethod,
          reference: parsed.data.reference,
          paidAt:
            parsed.data.paidAt === undefined
              ? undefined
              : new Date(parsed.data.paidAt),
          adminEmail: await adminGuard.getAdminEmail(headers),
        },
      );
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        paidAt: (invoice.paidAt as Date).toISOString(),
        paymentMethod: invoice.manualPaymentMethod as ManualPaymentMethod,
        reference: invoice.paymentReference,
      };
    },

    async setCommissionRate(
      headers,
      invoiceId,
      body,
    ): Promise<SetCommissionRateResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = setCommissionRateBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid rate body: rate must be a number satisfying 0 < rate <= 10 (percent).',
          false,
        );
      }
      const invoice = await commission.setCommissionRate(
        invoiceIdSchema.parse(invoiceId),
        parsed.data.rate,
        await adminGuard.getAdminEmail(headers),
      );
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        commissionRatePercent: invoice.commissionRateOverride ?? 0,
        contractValueCents: invoice.contractValueCents,
        commissionCents: invoice.commissionCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
        currency: invoice.currency,
      };
    },

    /**
     * Admin changes the planned payment method on one invoice. The
     * invoice's own tenant key is read admin-scoped first, so the
     * service's tenant check passes trivially — the exact same code
     * path (unpaid-only 409, conditional update, audit) as the builder
     * flow, with no widening of the builder route.
     */
    async setInvoicePaymentMethod(
      headers,
      invoiceId,
      body,
    ): Promise<AdminSetInvoicePaymentMethodResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = plannedPaymentMethodBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid payment method: expected one of card, cheque, e_transfer, bank_draft.',
          false,
        );
      }
      const id = invoiceIdSchema.parse(invoiceId);
      const invoice = await billing.getInvoice(id, null);
      const updated = await billing.setInvoicePaymentMethod(
        id,
        invoice.tenantKey,
        parsed.data.method,
      );
      return {
        invoiceId: updated.id,
        status: updated.status,
        paymentMethod: updated.paymentMethod,
      };
    },

    async createInvoice(headers, body): Promise<ManualInvoiceResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = manualInvoiceBodySchema(Date.now()).safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid invoice body: tenantKey, leadId (UUID), a positive ' +
            'contractValueCents, and contractSignedAt (ISO datetime with ' +
            'timezone offset, not in the future) are required.',
          false,
        );
      }
      // Same charge path as the builder-reported flow — attribution (12-month
      // window), draft invoice, auto-submitted into the 7-day review window.
      const result = await billing.reportContract({
        tenantKey: parsed.data.tenantKey,
        leadId: parsed.data.leadId,
        contractValueCents: parsed.data.contractValueCents,
        contractSignedAt: new Date(parsed.data.contractSignedAt),
      });
      if (!result.billed) {
        // e.g. the flat billing model: per-event commission is not the
        // charge path. 422 — the request is valid, the model refuses it.
        throw new HttpError(
          422,
          ErrorCodes.BILLING_MODEL_MISMATCH,
          `Invoice not created: ${result.reason}.`,
          false,
        );
      }
      const invoice = await commission.getById(result.invoiceId);
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        tenantKey: invoice.tenantKey,
        leadId: invoice.leadId,
        contractValueCents: invoice.contractValueCents,
        commissionCents: invoice.commissionCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
        currency: invoice.currency,
        reviewDueAt: invoice.reviewDueAt?.toISOString() ?? null,
      };
    },

    async refundInvoice(
      headers,
      invoiceId,
      body,
    ): Promise<RefundInvoiceResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = refundBodySchema.safeParse(body);
      if (!parsed.success) {
        throw invalidBody(
          'Invalid refund body: reason (duplicate | billing_error | ' +
            'deal_fell_through | goodwill | other) and idempotencyKey ' +
            '(8–100 of A–Z a–z 0–9 _ - :) are required; optional ' +
            'amountCents (positive integer), note (max 500 chars) and ' +
            'reference (max 120 chars).',
        );
      }
      const result = await commission.refundInvoice(
        invoiceIdSchema.parse(invoiceId),
        {
          ...parsed.data,
          adminEmail: await adminGuard.getAdminEmail(headers),
        },
      );
      const { invoice } = result;
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        totalCents: invoice.totalCents,
        refundedCents: invoice.refundedCents,
        netCents: invoice.totalCents - invoice.refundedCents,
        refundState: invoice.refundState,
        currency: invoice.currency,
        refund: toRefundDto(result.refund),
        replayed: result.replayed,
      };
    },

    async voidInvoice(headers, invoiceId, body): Promise<VoidInvoiceResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = voidBodySchema.safeParse(body);
      if (!parsed.success) {
        throw invalidBody(
          'Invalid void body: reason (duplicate | created_in_error | ' +
            'deal_fell_through | other) is required; optional note (max 500 chars).',
        );
      }
      const result = await commission.voidInvoice(
        invoiceIdSchema.parse(invoiceId),
        {
          ...parsed.data,
          adminEmail: await adminGuard.getAdminEmail(headers),
        },
      );
      return {
        invoiceId: result.invoice.id,
        status: result.invoice.status,
        previousStatus: result.previousStatus,
      };
    },

    async correctContract(
      headers,
      invoiceId,
      body,
    ): Promise<CorrectContractResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = correctContractBodySchema(Date.now()).safeParse(body);
      if (!parsed.success) {
        throw invalidBody(
          'Invalid contract correction: a positive contractValueCents ' +
            '(integer cents, excluding land), contractSignedAt (ISO datetime ' +
            'with timezone offset, not in the future) and a note (max 500 ' +
            'chars) are required.',
        );
      }
      const result = await commission.correctContract(
        invoiceIdSchema.parse(invoiceId),
        {
          contractValueCents: parsed.data.contractValueCents,
          contractSignedAt: new Date(parsed.data.contractSignedAt),
          note: parsed.data.note,
          adminEmail: await adminGuard.getAdminEmail(headers),
        },
      );
      const { invoice } = result;
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        previousContractValueCents: result.previousContractValueCents,
        contractValueCents: invoice.contractValueCents,
        contractSignedAt: result.contractSignedAt.toISOString(),
        commissionCents: invoice.commissionCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
        currency: invoice.currency,
        reviewDueAt: invoice.reviewDueAt?.toISOString() ?? null,
      };
    },

    async reverseManualPayment(
      headers,
      invoiceId,
      body,
    ): Promise<ReverseManualPaymentResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = reversePaymentBodySchema.safeParse(body);
      if (!parsed.success) {
        throw invalidBody(
          'Invalid reversal body: a reason (max 500 chars) is required.',
        );
      }
      const result = await commission.reverseManualPayment(
        invoiceIdSchema.parse(invoiceId),
        {
          reason: parsed.data.reason,
          adminEmail: await adminGuard.getAdminEmail(headers),
        },
      );
      return {
        invoiceId: result.invoice.id,
        status: result.invoice.status,
        reversedPaymentMethod: result.reversedPaymentMethod,
        reversedReference: result.reversedReference,
      };
    },
  };
}
