/**
 * Admin billing-health route tests (billing/03 follow-on — /admin/billing).
 *
 * The route is thin: admin guard → one service method → response shape.
 * Real business logic lives in the service (covered by
 * billing-health.service.test.ts).
 *
 * AC: admin-auth required; non-admin → 401.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminBillingRoute,
  type AdminBillingRouteDeps,
} from '../src/routes/admin-billing.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { BillingHealthService } from '../src/services/billing/billing-health.service';
import type { BillingHealthResponse } from '@feasly/contracts';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };

const HEALTH_RESPONSE: BillingHealthResponse = {
  model: 'commission',
  stripe: { configured: true, testMode: true },
  generatedAt: '2026-09-26T12:00:00.000Z',
  mrr: {
    cents: null,
    currency: 'CAD',
    activeSubscriptions: 0,
    source: 'not_applicable',
  },
  collectedTrailing30d: { count: 1, commissionCents: 40_000 },
  inReview: {
    under48h: { count: 1, commissionCents: 10_000 },
    under7d: { count: 0, commissionCents: 0 },
    overdue: { count: 0, commissionCents: 0 },
  },
  disputed: { count: 0, commissionCents: 0 },
  dunning: [],
  inReviewInvoices: [],
  maxChargeRetries: 3,
  webhooks: {
    received24h: 3,
    lastReceivedAt: '2026-09-26T10:00:00.000Z',
    byType24h: [{ type: 'payment_intent.succeeded', count: 3 }],
    unhandled24h: 0,
    modelMismatch24h: 0,
  },
};

function makeDeps(): AdminBillingRouteDeps {
  const service: BillingHealthService = {
    getHealth: vi.fn().mockResolvedValue(HEALTH_RESPONSE),
  };
  return {
    billingHealth: service,
    adminGuard: {
      async requireAdmin(
        headers: Record<string, string | string[] | undefined>,
      ) {
        const cookie = headers['cookie'];
        const value = Array.isArray(cookie) ? cookie[0] : cookie;
        if (value !== 'feasly_admin_session=valid-test-session') {
          throw new HttpError(
            401,
            ErrorCodes.UNAUTHENTICATED,
            'Admin session required.',
            false,
          );
        }
      },
      async getAdminEmail() {
        return 'karanbirsingh667@gmail.com';
      },
    },
    commission: {
      retryCharge: vi.fn(),
      getById: vi.fn(),
      markPaidManually: vi.fn(),
      setCommissionRate: vi.fn(),
    } as unknown as import('../src/services/billing/commission.service').CommissionService,
    billing: {
      reportContract: vi.fn(),
    } as unknown as import('../src/services/billing/billing.service').BillingService,
  };
}

describe('admin-billing route', () => {
  it('returns the health payload for an admin session', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    const result = await route.getHealth(ADMIN_HEADERS);
    expect(result).toBe(HEALTH_RESPONSE);
    expect(deps.billingHealth.getHealth).toHaveBeenCalledTimes(1);
  });

  it('rejects non-admin callers with 401', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    await expect(route.getHealth({})).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
    expect(deps.billingHealth.getHealth).not.toHaveBeenCalled();
  });
});

describe('admin-billing route retryCharge', () => {
  const INVOICE_ID = '11111111-1111-4111-8111-111111111111';

  it('retries the charge for an admin session', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    const commission = deps.commission as unknown as {
      retryCharge: ReturnType<typeof vi.fn>;
    };
    commission.retryCharge.mockResolvedValue({
      id: INVOICE_ID,
      status: 'finalized',
      retryCount: 1,
    });
    const result = await route.retryCharge(ADMIN_HEADERS, INVOICE_ID);
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: 'finalized',
      retryCount: 1,
    });
    expect(commission.retryCharge).toHaveBeenCalledWith(INVOICE_ID);
  });

  it('rejects non-admin callers with 401 without calling the service', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    const commission = deps.commission as unknown as {
      retryCharge: ReturnType<typeof vi.fn>;
    };
    await expect(route.retryCharge({}, INVOICE_ID)).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
    expect(commission.retryCharge).not.toHaveBeenCalled();
  });

  it('rejects a malformed invoice id', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    await expect(
      route.retryCharge(ADMIN_HEADERS, 'not-a-uuid'),
    ).rejects.toThrow();
  });
});

describe('admin-billing route createInvoice', () => {
  const LEAD_ID = '22222222-2222-4222-8222-222222222222';
  const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
  const VALID_BODY = {
    tenantKey: 'test-builder',
    leadId: LEAD_ID,
    contractValueCents: 850_000_00,
    contractSignedAt: '2026-09-20T14:30:00-06:00',
  };

  const INVOICE_RECORD = {
    id: INVOICE_ID,
    tenantKey: 'test-builder',
    attributionId: '44444444-4444-4444-8444-444444444444',
    leadId: LEAD_ID,
    contractValueCents: 850_000_00,
    commissionCents: 8_500_00,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status: 'in_review',
    reviewDueAt: new Date('2026-09-27T14:30:00.000Z'),
    finalizedAt: null,
    paidAt: null,
    slaBreached: false,
    disputeReason: null,
    retryCount: 0,
    createdAt: new Date('2026-09-20T14:30:00.000Z'),
    updatedAt: new Date('2026-09-20T14:30:00.000Z'),
  };

  function mockBilled() {
    const deps = makeDeps();
    const billing = deps.billing as unknown as {
      reportContract: ReturnType<typeof vi.fn>;
    };
    const commission = deps.commission as unknown as {
      getById: ReturnType<typeof vi.fn>;
    };
    billing.reportContract.mockResolvedValue({
      billed: true,
      invoiceId: INVOICE_ID,
      invoiceStatus: 'in_review',
    });
    commission.getById.mockResolvedValue(INVOICE_RECORD);
    return { deps, billing, commission };
  }

  it('creates the invoice through the shared charge path and returns the invoice detail', async () => {
    const { deps, billing, commission } = mockBilled();
    const route = createAdminBillingRoute(deps);
    const result = await route.createInvoice(ADMIN_HEADERS, VALID_BODY);
    expect(billing.reportContract).toHaveBeenCalledTimes(1);
    expect(billing.reportContract).toHaveBeenCalledWith({
      tenantKey: 'test-builder',
      leadId: LEAD_ID,
      contractValueCents: 850_000_00,
      contractSignedAt: new Date('2026-09-20T14:30:00-06:00'),
    });
    expect(commission.getById).toHaveBeenCalledWith(INVOICE_ID);
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: 'in_review',
      tenantKey: 'test-builder',
      leadId: LEAD_ID,
      contractValueCents: 850_000_00,
      commissionCents: 8_500_00,
      currency: 'CAD',
      reviewDueAt: '2026-09-27T14:30:00.000Z',
    });
  });

  it('rejects non-admin callers with 401 without calling the service', async () => {
    const { deps, billing } = mockBilled();
    const route = createAdminBillingRoute(deps);
    await expect(route.createInvoice({}, VALID_BODY)).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
    expect(billing.reportContract).not.toHaveBeenCalled();
  });

  it.each([
    ['bad leadId', { ...VALID_BODY, leadId: 'not-a-uuid' }],
    ['empty tenantKey', { ...VALID_BODY, tenantKey: '  ' }],
    ['zero contract value', { ...VALID_BODY, contractValueCents: 0 }],
    ['negative contract value', { ...VALID_BODY, contractValueCents: -5 }],
    [
      'fractional cents',
      { ...VALID_BODY, contractValueCents: 100.5 },
    ],
    [
      'datetime without offset',
      { ...VALID_BODY, contractSignedAt: '2026-09-20T14:30:00' },
    ],
    ['plain date', { ...VALID_BODY, contractSignedAt: '2026-09-20' }],
  ])('rejects %s with 400', async (_label, body) => {
    const { deps, billing } = mockBilled();
    const route = createAdminBillingRoute(deps);
    await expect(route.createInvoice(ADMIN_HEADERS, body)).rejects.toMatchObject(
      {
        status: 400,
        code: ErrorCodes.VALIDATION_FAILED,
      },
    );
    expect(billing.reportContract).not.toHaveBeenCalled();
  });

  it('propagates the 404 when the lead does not exist', async () => {
    const { deps, billing } = mockBilled();
    billing.reportContract.mockRejectedValue(
      new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false),
    );
    const route = createAdminBillingRoute(deps);
    await expect(
      route.createInvoice(ADMIN_HEADERS, VALID_BODY),
    ).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it('propagates the 403 when the lead belongs to a different builder', async () => {
    const { deps, billing } = mockBilled();
    billing.reportContract.mockRejectedValue(
      new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'This lead belongs to a different builder.',
        false,
      ),
    );
    const route = createAdminBillingRoute(deps);
    await expect(
      route.createInvoice(ADMIN_HEADERS, VALID_BODY),
    ).rejects.toMatchObject({
      status: 403,
      code: ErrorCodes.FORBIDDEN,
    });
  });

  it('returns 422 when the billing model refuses per-event invoicing', async () => {
    const { deps, billing } = mockBilled();
    billing.reportContract.mockResolvedValue({
      billed: false,
      reason: 'flat_subscription_covers',
    });
    const route = createAdminBillingRoute(deps);
    await expect(
      route.createInvoice(ADMIN_HEADERS, VALID_BODY),
    ).rejects.toMatchObject({
      status: 422,
      code: ErrorCodes.BILLING_MODEL_MISMATCH,
    });
  });
});

describe('admin-billing route markPaid', () => {
  const INVOICE_ID = '22222222-2222-4222-8222-222222222222';

  it('marks the invoice paid for an admin session and maps the response', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    const markPaidManually = deps.commission
      .markPaidManually as unknown as ReturnType<typeof vi.fn>;
    markPaidManually.mockResolvedValue({
      id: INVOICE_ID,
      status: 'paid',
      paidAt: new Date('2026-09-29T18:00:00.000Z'),
      manualPaymentMethod: 'cheque',
      paymentReference: 'CHQ-1234',
    });
    const result = await route.markPaid(ADMIN_HEADERS, INVOICE_ID, {
      paymentMethod: 'cheque',
      reference: 'CHQ-1234',
      paidAt: '2026-09-29T12:00:00-06:00',
    });
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: 'paid',
      paidAt: '2026-09-29T18:00:00.000Z',
      paymentMethod: 'cheque',
      reference: 'CHQ-1234',
    });
    expect(markPaidManually).toHaveBeenCalledWith(INVOICE_ID, {
      paymentMethod: 'cheque',
      reference: 'CHQ-1234',
      paidAt: new Date('2026-09-29T18:00:00.000Z'),
      adminEmail: 'karanbirsingh667@gmail.com',
    });
  });

  it('rejects non-admin callers with 401 before touching the service', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    await expect(
      route.markPaid({}, INVOICE_ID, { paymentMethod: 'cash' }),
    ).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
    expect(deps.commission.markPaidManually).not.toHaveBeenCalled();
  });

  it('400s on an unknown payment method, malformed paidAt, or a non-UUID id', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    await expect(
      route.markPaid(ADMIN_HEADERS, INVOICE_ID, { paymentMethod: 'wire' }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    await expect(
      route.markPaid(ADMIN_HEADERS, INVOICE_ID, {
        paymentMethod: 'cash',
        paidAt: 'next Tuesday',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    await expect(
      route.markPaid(ADMIN_HEADERS, 'not-a-uuid', { paymentMethod: 'cash' }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    expect(deps.commission.markPaidManually).not.toHaveBeenCalled();
  });

  it('propagates the service 409 for an already-paid invoice', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    (deps.commission.markPaidManually as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new HttpError(409, ErrorCodes.CONFLICT, 'Already paid.'));
    await expect(
      route.markPaid(ADMIN_HEADERS, INVOICE_ID, { paymentMethod: 'cash' }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
  });
});

describe('admin-billing route setCommissionRate', () => {
  const INVOICE_ID = '33333333-3333-4333-8333-333333333333';

  it('overrides the rate for an admin session and maps the response', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    const setCommissionRate = deps.commission
      .setCommissionRate as unknown as ReturnType<typeof vi.fn>;
    setCommissionRate.mockResolvedValue({
      id: INVOICE_ID,
      status: 'in_review',
      commissionRateOverride: 1.5,
      contractValueCents: 50_000_000,
      commissionCents: 750_000,
      currency: 'CAD',
    });
    const result = await route.setCommissionRate(ADMIN_HEADERS, INVOICE_ID, {
      rate: 1.5,
    });
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: 'in_review',
      commissionRatePercent: 1.5,
      contractValueCents: 50_000_000,
      commissionCents: 750_000,
      currency: 'CAD',
    });
    expect(setCommissionRate).toHaveBeenCalledWith(
      INVOICE_ID,
      1.5,
      'karanbirsingh667@gmail.com',
    );
  });

  it('rejects non-admin callers with 401 before touching the service', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    await expect(route.setCommissionRate({}, INVOICE_ID, { rate: 1.5 })).rejects
      .toMatchObject({ status: 401, code: ErrorCodes.UNAUTHENTICATED });
    expect(deps.commission.setCommissionRate).not.toHaveBeenCalled();
  });

  it('400s on zero, negative, >10, non-numeric, and missing rates', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    for (const bad of [0, -1, 10.0001, Number.NaN, '1.5', undefined]) {
      await expect(
        route.setCommissionRate(ADMIN_HEADERS, INVOICE_ID, { rate: bad }),
      ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    }
    expect(deps.commission.setCommissionRate).not.toHaveBeenCalled();
  });

  it('propagates the service 409 for a settled invoice', async () => {
    const deps = makeDeps();
    const route = createAdminBillingRoute(deps);
    (deps.commission.setCommissionRate as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new HttpError(409, ErrorCodes.CONFLICT, 'Settled.'));
    await expect(
      route.setCommissionRate(ADMIN_HEADERS, INVOICE_ID, { rate: 1.5 }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
  });
});
