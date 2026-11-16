/**
 * Admin billing correction routes (#715): refund, void, correct-contract,
 * reverse-payment. The route is thin — admin guard → body validation → one
 * service call → response mapping. The money logic is covered by
 * invoice-adjustments.service.test.ts; the 403 + authz.denied gate by
 * admin-billing-permissions.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminBillingRoute,
  type AdminBillingRouteDeps,
} from '../src/routes/admin-billing.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { CommissionService } from '../src/services/billing/commission.service';
import type { BillingService } from '../src/services/billing/billing.service';
import type { BillingHealthService } from '../src/services/billing/billing-health.service';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };
const ADMIN_EMAIL = 'ops-admin@example.com';
const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
const CREATED = new Date('2026-11-16T12:00:00.000Z');

function makeDeps() {
  const commission = {
    refundInvoice: vi.fn(),
    voidInvoice: vi.fn(),
    correctContract: vi.fn(),
    reverseManualPayment: vi.fn(),
  };
  const deps: AdminBillingRouteDeps = {
    billingHealth: { getHealth: vi.fn() } as unknown as BillingHealthService,
    billing: {} as unknown as BillingService,
    commission: commission as unknown as CommissionService,
    adminGuard: {
      async requireAdmin(headers) {
        if (headers['cookie'] !== ADMIN_HEADERS.cookie) {
          throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin session required.', false);
        }
      },
      async getAdminEmail() {
        return ADMIN_EMAIL;
      },
    },
  };
  return { deps, commission, route: createAdminBillingRoute(deps) };
}

const REFUND = {
  id: 'rf-1',
  invoiceId: INVOICE_ID,
  amountCents: 50_000,
  currency: 'CAD',
  reason: 'billing_error' as const,
  note: null,
  method: 'stripe' as const,
  status: 'succeeded' as const,
  stripeRefundId: 're_1',
  reference: null,
  actorEmail: ADMIN_EMAIL,
  createdAt: CREATED,
};

describe('POST /admin/billing/invoices/{id}/refund', () => {
  const body = {
    amountCents: 50_000,
    reason: 'billing_error',
    idempotencyKey: 'modal-7f3a9c21',
  };

  it('refunds via the service with the admin identity and maps net/refund totals', async () => {
    const { route, commission } = makeDeps();
    commission.refundInvoice.mockResolvedValue({
      invoice: {
        id: INVOICE_ID,
        status: 'paid',
        totalCents: 1_875_000,
        refundedCents: 50_000,
        refundState: 'partially_refunded',
        currency: 'CAD',
      },
      refund: REFUND,
      replayed: false,
    });
    const result = await route.refundInvoice(ADMIN_HEADERS, INVOICE_ID, body);
    expect(commission.refundInvoice).toHaveBeenCalledWith(INVOICE_ID, {
      ...body,
      adminEmail: ADMIN_EMAIL,
    });
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: 'paid',
      totalCents: 1_875_000,
      refundedCents: 50_000,
      netCents: 1_825_000,
      refundState: 'partially_refunded',
      currency: 'CAD',
      refund: { ...REFUND, createdAt: CREATED.toISOString() },
      replayed: false,
    });
  });

  it('401s without an admin session, before the service', async () => {
    const { route, commission } = makeDeps();
    await expect(route.refundInvoice({}, INVOICE_ID, body)).rejects.toMatchObject({
      status: 401,
    });
    expect(commission.refundInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ['missing idempotency key', { reason: 'other' }],
    ['short idempotency key', { reason: 'other', idempotencyKey: 'abc' }],
    ['unknown reason', { reason: 'because', idempotencyKey: 'modal-7f3a9c21' }],
    ['fractional cents', { ...body, amountCents: 10.5 }],
    ['zero amount', { ...body, amountCents: 0 }],
    ['note too long', { ...body, note: 'x'.repeat(501) }],
  ])('400s on %s', async (_label, bad) => {
    const { route, commission } = makeDeps();
    await expect(route.refundInvoice(ADMIN_HEADERS, INVOICE_ID, bad)).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(commission.refundInvoice).not.toHaveBeenCalled();
  });

  it('propagates the service 422 (nothing left to refund)', async () => {
    const { route, commission } = makeDeps();
    commission.refundInvoice.mockRejectedValue(
      new HttpError(422, ErrorCodes.VALIDATION_FAILED, 'already fully refunded'),
    );
    await expect(route.refundInvoice(ADMIN_HEADERS, INVOICE_ID, body)).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('POST /admin/billing/invoices/{id}/void', () => {
  it('voids via the service and returns the previous status', async () => {
    const { route, commission } = makeDeps();
    commission.voidInvoice.mockResolvedValue({
      invoice: { id: INVOICE_ID, status: 'void' },
      previousStatus: 'in_review',
    });
    const result = await route.voidInvoice(ADMIN_HEADERS, INVOICE_ID, {
      reason: 'duplicate',
      note: 'Entered twice',
    });
    expect(commission.voidInvoice).toHaveBeenCalledWith(INVOICE_ID, {
      reason: 'duplicate',
      note: 'Entered twice',
      adminEmail: ADMIN_EMAIL,
    });
    expect(result).toEqual({ invoiceId: INVOICE_ID, status: 'void', previousStatus: 'in_review' });
  });

  it('400s on a missing/unknown reason and a non-UUID id', async () => {
    const { route } = makeDeps();
    await expect(route.voidInvoice(ADMIN_HEADERS, INVOICE_ID, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      route.voidInvoice(ADMIN_HEADERS, INVOICE_ID, { reason: 'nope' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.voidInvoice(ADMIN_HEADERS, 'not-a-uuid', { reason: 'other' }),
    ).rejects.toThrow();
  });

  it('propagates the service 409 (finalized / paid)', async () => {
    const { route, commission } = makeDeps();
    commission.voidInvoice.mockRejectedValue(
      new HttpError(409, ErrorCodes.CONFLICT, 'a charge is in flight'),
    );
    await expect(
      route.voidInvoice(ADMIN_HEADERS, INVOICE_ID, { reason: 'other' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('POST /admin/billing/invoices/{id}/correct-contract', () => {
  const body = {
    contractValueCents: 150_000_000,
    contractSignedAt: '2026-11-09T10:00:00-07:00',
    note: 'Price included land',
  };

  it('corrects via the service and maps the recalculated figures', async () => {
    const { route, commission } = makeDeps();
    const reviewDueAt = new Date('2026-11-23T12:00:00.000Z');
    commission.correctContract.mockResolvedValue({
      invoice: {
        id: INVOICE_ID,
        status: 'in_review',
        contractValueCents: 150_000_000,
        commissionCents: 1_500_000,
        taxCents: 75_000,
        totalCents: 1_575_000,
        currency: 'CAD',
        reviewDueAt,
      },
      previousContractValueCents: 187_500_000,
      contractSignedAt: new Date('2026-11-09T17:00:00.000Z'),
    });
    const result = await route.correctContract(ADMIN_HEADERS, INVOICE_ID, body);
    expect(commission.correctContract).toHaveBeenCalledWith(INVOICE_ID, {
      contractValueCents: 150_000_000,
      contractSignedAt: new Date('2026-11-09T17:00:00.000Z'),
      note: 'Price included land',
      adminEmail: ADMIN_EMAIL,
    });
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: 'in_review',
      previousContractValueCents: 187_500_000,
      contractValueCents: 150_000_000,
      contractSignedAt: '2026-11-09T17:00:00.000Z',
      commissionCents: 1_500_000,
      taxCents: 75_000,
      totalCents: 1_575_000,
      currency: 'CAD',
      reviewDueAt: reviewDueAt.toISOString(),
    });
  });

  it.each([
    ['missing note', { ...body, note: undefined }],
    ['blank note', { ...body, note: '   ' }],
    ['future signed date', { ...body, contractSignedAt: '2999-01-01T00:00:00Z' }],
    ['date without offset', { ...body, contractSignedAt: '2026-11-09T10:00:00' }],
    ['non-integer value', { ...body, contractValueCents: 1.5 }],
  ])('400s on %s', async (_label, bad) => {
    const { route, commission } = makeDeps();
    await expect(route.correctContract(ADMIN_HEADERS, INVOICE_ID, bad)).rejects.toMatchObject({
      status: 400,
    });
    expect(commission.correctContract).not.toHaveBeenCalled();
  });
});

describe('POST /admin/billing/invoices/{id}/reverse-payment', () => {
  it('reverses via the service with a mandatory reason', async () => {
    const { route, commission } = makeDeps();
    commission.reverseManualPayment.mockResolvedValue({
      invoice: { id: INVOICE_ID, status: 'failed' },
      reversedPaymentMethod: 'cheque',
      reversedReference: 'CHQ-2041',
    });
    const result = await route.reverseManualPayment(ADMIN_HEADERS, INVOICE_ID, {
      reason: 'Cheque returned NSF',
    });
    expect(commission.reverseManualPayment).toHaveBeenCalledWith(INVOICE_ID, {
      reason: 'Cheque returned NSF',
      adminEmail: ADMIN_EMAIL,
    });
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: 'failed',
      reversedPaymentMethod: 'cheque',
      reversedReference: 'CHQ-2041',
    });
  });

  it('400s without a reason', async () => {
    const { route, commission } = makeDeps();
    await expect(route.reverseManualPayment(ADMIN_HEADERS, INVOICE_ID, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      route.reverseManualPayment(ADMIN_HEADERS, INVOICE_ID, { reason: '  ' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(commission.reverseManualPayment).not.toHaveBeenCalled();
  });
});
