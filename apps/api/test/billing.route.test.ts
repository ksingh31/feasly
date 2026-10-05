/**
 * Billing route tests (billing/01 first charge path).
 *
 * Thin-route contract: validate input → enforce auth → call exactly one
 * service method → return the result. All billing logic lives in the
 * service; these tests pin the HTTP surface:
 * - POST /api/v1/billing/report-contract — builder-auth required, 400 on
 *   invalid body, delegates with the session tenant key.
 * - GET /api/v1/billing/invoices/{id} — builder sees only their tenant's
 *   invoices; admin sees all; invalid id is 400.
 * - POST /api/v1/billing/invoices/{id}/dispute — builder-auth required,
 *   reason required, tenant-scoped.
 * - POST /api/v1/billing/invoices/{id}/resolve — admin-only.
 *
 * Fakes in-memory: no DB, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBillingRoute,
  type BillingRouteDeps,
} from '../src/routes/billing.route';
import type { BillingService } from '../src/services/billing/billing.service';
import type { CommissionCardService } from '../src/services/billing/commission-card.service';
import type { BuilderGuard } from '../src/middleware/builder-guard';
import type { AdminGuard } from '../src/middleware/admin-guard';

const BUILDER_SESSION = {
  email: 'builder@example.com',
  tenantKey: 'elite-craft',
};

function makeDeps(opts?: {
  readonly builderSession?: typeof BUILDER_SESSION | null;
  readonly admin?: boolean;
  readonly billingModel?: 'commission' | 'flat';
  readonly stripeConfigured?: boolean;
  readonly card?: { hasCard: boolean; brand?: string; last4?: string };
}): {
  route: ReturnType<typeof createBillingRoute>;
  billing: BillingService;
  commissionCard: CommissionCardService;
} {
  const builderSession = opts?.builderSession === undefined ? BUILDER_SESSION : opts.builderSession;
  const builderGuard: BuilderGuard = {
    requireBuilder: async () => {},
    getBuilderSession: async () =>
      builderSession === null ? null : { ...builderSession },
  } as unknown as BuilderGuard;
  const adminGuard: AdminGuard = {
    requireAdmin: async () => {
      if (!opts?.admin) {
        throw Object.assign(new Error('admin required'), { status: 401 });
      }
    },
    getAdminEmail: async () => (opts?.admin ? 'admin@feasly.dev' : null),
  } as unknown as AdminGuard;

  const billing: BillingService = {
    reportContract: vi.fn(async () => ({
      billed: true,
      invoiceId: 'inv-1',
      invoiceStatus: 'in_review',
    })),
    getInvoice: vi.fn(async (invoiceId: string, tenantKey: string | null) => {
      if (tenantKey !== null && tenantKey !== 'elite-craft') {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      return { id: invoiceId, tenantKey: 'elite-craft', status: 'in_review' };
    }),
    disputeInvoice: vi.fn(async () => ({
      id: 'inv-1',
      tenantKey: 'elite-craft',
      status: 'disputed',
    })),
    resolveDispute: vi.fn(async () => ({
      id: 'inv-1',
      tenantKey: 'elite-craft',
      status: 'in_review',
    })),
    listInvoices: vi.fn(async (tenantKey: string | null) => {
      const all = [
        { id: 'inv-1', tenantKey: 'elite-craft', status: 'in_review' },
        { id: 'inv-2', tenantKey: 'other-builder', status: 'paid' },
      ];
      return tenantKey === null
        ? all
        : all.filter((i) => i.tenantKey === tenantKey);
    }),
    getCommissionRatePercent: vi.fn(async (tenantKey: string) =>
      tenantKey === 'elite-craft' ? 1.5 : 1,
    ),
    getDefaultPaymentMethod: vi.fn(async () => 'cheque'),
    setDefaultPaymentMethod: vi.fn(async (_tenantKey: string, method: string) => method),
    setInvoicePaymentMethod: vi.fn(
      async (invoiceId: string, tenantKey: string, method: string) => ({
        id: invoiceId,
        tenantKey,
        paymentMethod: method,
      }),
    ),
  } as unknown as BillingService;

  const model = opts?.billingModel ?? 'commission';
  const stripeConfigured = opts?.stripeConfigured ?? true;
  const card = opts?.card ?? { hasCard: true, brand: 'visa', last4: '4242' };
  const commissionCard: CommissionCardService = {
    ensureCustomer: vi.fn(async (tenantKey: string) => {
      if (model !== 'commission') {
        throw Object.assign(new Error('model mismatch'), {
          status: 409,
          code: 'BILLING_MODEL_MISMATCH',
        });
      }
      if (!stripeConfigured) {
        throw Object.assign(new Error('not configured'), { status: 422 });
      }
      return `cus_${tenantKey}`;
    }),
    createSetupIntent: vi.fn(async () => {
      if (model !== 'commission') {
        throw Object.assign(new Error('model mismatch'), {
          status: 409,
          code: 'BILLING_MODEL_MISMATCH',
        });
      }
      if (!stripeConfigured) {
        throw Object.assign(new Error('not configured'), { status: 422 });
      }
      return { setupIntentId: 'seti_1', clientSecret: 'seti_1_secret_xxx' };
    }),
    getCard: vi.fn(async () => {
      if (model !== 'commission') {
        throw Object.assign(new Error('model mismatch'), {
          status: 409,
          code: 'BILLING_MODEL_MISMATCH',
        });
      }
      return card;
    }),
  } as unknown as CommissionCardService;

  const deps: BillingRouteDeps = {
    billing,
    commissionCard,
    builderGuard,
    adminGuard,
  };
  return { route: createBillingRoute(deps), billing, commissionCard };
}

describe('POST /api/v1/billing/report-contract', () => {
  const body = {
    leadId: '00000000-0000-4000-8000-000000000001',
    contractValueCents: 50_000_000,
    contractSignedAt: '2026-09-20T10:00:00.000Z',
  };

  it('delegates with the session tenant key and parsed contract', async () => {
    const { route, billing } = makeDeps();
    const result = await route.reportContract({}, body);

    expect(billing.reportContract).toHaveBeenCalledTimes(1);
    expect(billing.reportContract).toHaveBeenCalledWith({
      tenantKey: 'elite-craft',
      leadId: body.leadId,
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
    });
    expect(result).toMatchObject({ billed: true, invoiceId: 'inv-1' });
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route } = makeDeps({ builderSession: null, admin: true });
    await expect(route.reportContract({}, body)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects an invalid body with 400', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.reportContract({}, { leadId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.reportContract).not.toHaveBeenCalled();
  });

  it('rejects a future contractSignedAt with 400 (QA P6)', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.reportContract({}, { ...body, contractSignedAt: '2099-01-01T12:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.reportContract).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/billing/invoices/{id}', () => {
  const id = '00000000-0000-4000-8000-000000000002';

  it('builder reads their own tenant invoice', async () => {
    const { route } = makeDeps();
    const result = await route.getInvoice({}, id);
    expect(result).toMatchObject({ id, tenantKey: 'elite-craft' });
  });

  it('admin reads any invoice', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: true });
    const result = await route.getInvoice({}, id);
    expect(billing.getInvoice).toHaveBeenCalledWith(id, null);
    expect(result).toMatchObject({ id });
  });

  it('unauthenticated callers are rejected', async () => {
    const { route } = makeDeps({ builderSession: null, admin: false });
    await expect(route.getInvoice({}, id)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a non-uuid id with 400', async () => {
    const { route } = makeDeps();
    await expect(route.getInvoice({}, 'nope')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('GET /api/v1/billing/commission-rate (billing/08)', () => {
  it('returns the calling builder\u2019s rate', async () => {
    const { route, billing } = makeDeps();
    const result = await route.getCommissionRate({});
    expect(result).toEqual({ commissionRatePercent: 1.5 });
    expect(billing.getCommissionRatePercent).toHaveBeenCalledWith(
      'elite-craft',
    );
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route } = makeDeps({ builderSession: null, admin: false });
    await expect(route.getCommissionRate({})).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('POST /api/v1/billing/invoices/{id}/dispute', () => {
  const id = '00000000-0000-4000-8000-000000000003';

  it('builder disputes with a reason', async () => {
    const { route, billing } = makeDeps();
    const result = await route.disputeInvoice({}, id, {
      reason: 'We never signed this contract.',
    });
    expect(billing.disputeInvoice).toHaveBeenCalledWith(
      id,
      'elite-craft',
      'We never signed this contract.',
    );
    expect(result).toMatchObject({ status: 'disputed' });
  });

  it('requires a non-empty reason (400)', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.disputeInvoice({}, id, { reason: '   ' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.disputeInvoice).not.toHaveBeenCalled();
  });

  it('requires builder auth', async () => {
    const { route } = makeDeps({ builderSession: null, admin: true });
    await expect(
      route.disputeInvoice({}, id, { reason: 'x' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('POST /api/v1/billing/invoices/{id}/resolve', () => {
  const id = '00000000-0000-4000-8000-000000000004';

  it('admin resolves with resume', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: true });
    await route.resolveDispute({}, id, { outcome: 'resume' });
    expect(billing.resolveDispute).toHaveBeenCalledWith(id, 'resume');
  });

  it('rejects an invalid outcome with 400', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: true });
    await expect(
      route.resolveDispute({}, id, { outcome: 'maybe' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.resolveDispute).not.toHaveBeenCalled();
  });

  it('builders cannot resolve (admin-only)', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.resolveDispute({}, id, { outcome: 'void' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(billing.resolveDispute).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/billing/setup-intent (BILL-02)', () => {
  it('returns the client secret and ensures the customer first', async () => {
    const { route, commissionCard } = makeDeps();
    const result = await route.createSetupIntent({});
    expect(result).toEqual({
      setupIntentId: 'seti_1',
      clientSecret: 'seti_1_secret_xxx',
    });
    expect(commissionCard.ensureCustomer).toHaveBeenCalledWith(
      'elite-craft',
      'builder@example.com',
    );
    expect(commissionCard.createSetupIntent).toHaveBeenCalledWith(
      'elite-craft',
    );
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route, commissionCard } = makeDeps({ builderSession: null });
    await expect(route.createSetupIntent({})).rejects.toMatchObject({
      status: 401,
    });
    expect(commissionCard.createSetupIntent).not.toHaveBeenCalled();
  });

  it('409s under the flat model', async () => {
    const { route } = makeDeps({ billingModel: 'flat' });
    await expect(route.createSetupIntent({})).rejects.toMatchObject({
      status: 409,
      code: 'BILLING_MODEL_MISMATCH',
    });
  });

  it('422s when Stripe is not configured', async () => {
    const { route } = makeDeps({ stripeConfigured: false });
    await expect(route.createSetupIntent({})).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('GET /api/v1/billing/card (BILL-02)', () => {
  it('returns the card summary for the session tenant', async () => {
    const { route, commissionCard } = makeDeps();
    const result = await route.getCard({});
    expect(result).toEqual({ hasCard: true, brand: 'visa', last4: '4242' });
    expect(commissionCard.getCard).toHaveBeenCalledWith('elite-craft');
  });

  it('reports hasCard: false when no card is on file', async () => {
    const { route } = makeDeps({ card: { hasCard: false } });
    await expect(route.getCard({})).resolves.toEqual({ hasCard: false });
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route, commissionCard } = makeDeps({ builderSession: null });
    await expect(route.getCard({})).rejects.toMatchObject({ status: 401 });
    expect(commissionCard.getCard).not.toHaveBeenCalled();
  });

  it('409s under the flat model', async () => {
    const { route } = makeDeps({ billingModel: 'flat' });
    await expect(route.getCard({})).rejects.toMatchObject({
      status: 409,
      code: 'BILLING_MODEL_MISMATCH',
    });
  });
});

describe('GET /api/v1/billing/invoices (BILL-04)', () => {
  it('builder session scopes the list to their tenant', async () => {
    const { route, billing } = makeDeps();
    const result = await route.listInvoices({}, { limit: '20', offset: '0' });

    expect(billing.listInvoices).toHaveBeenCalledWith('elite-craft', {
      limit: 20,
      offset: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0].tenantKey).toBe('elite-craft');
  });

  it('admin (no builder session) sees all tenants', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: true });
    const result = await route.listInvoices({}, {});

    expect(billing.listInvoices).toHaveBeenCalledWith(null, {
      limit: 20,
      offset: 0,
    });
    expect(result).toHaveLength(2);
  });

  it('applies limit/offset defaults', async () => {
    const { route, billing } = makeDeps();
    await route.listInvoices({}, {});

    expect(billing.listInvoices).toHaveBeenCalledWith('elite-craft', {
      limit: 20,
      offset: 0,
    });
  });

  it('passes an invoice-number search through to the service', async () => {
    const { route, billing } = makeDeps();
    await route.listInvoices(
      {},
      { limit: '20', offset: '0', invoiceNumber: '  inv-0042 ' },
    );

    expect(billing.listInvoices).toHaveBeenCalledWith('elite-craft', {
      limit: 20,
      offset: 0,
      invoiceNumber: 'inv-0042',
    });
  });

  it('passes a comma-separated status filter through to the service', async () => {
    const { route, billing } = makeDeps();
    await route.listInvoices(
      {},
      { limit: '100', offset: '0', status: 'failed,in_review' },
    );

    expect(billing.listInvoices).toHaveBeenCalledWith('elite-craft', {
      limit: 100,
      offset: 0,
      status: ['failed', 'in_review'],
    });
  });

  it('ignores unknown status values (fail open to no filter)', async () => {
    const { route, billing } = makeDeps();
    await route.listInvoices({}, { limit: '20', offset: '0', status: 'bogus' });

    expect(billing.listInvoices).toHaveBeenCalledWith('elite-craft', {
      limit: 20,
      offset: 0,
      status: undefined,
    });
  });

  it('rejects out-of-range pagination with 400', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.listInvoices({}, { limit: '500', offset: '0' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.listInvoices({}, { limit: '20', offset: '-5' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.listInvoices).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit with 400', async () => {
    const { route } = makeDeps();
    await expect(route.listInvoices({}, { limit: 'abc' })).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it('requires auth (401 without a session and without admin)', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: false });
    await expect(route.listInvoices({}, {})).rejects.toMatchObject({
      status: 401,
    });
    expect(billing.listInvoices).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/billing/payment-method (billing/12)', () => {
  it('returns the calling builder\u2019s default payment method', async () => {
    const { route, billing } = makeDeps();
    const result = await route.getDefaultPaymentMethod({});
    expect(result).toEqual({ defaultMethod: 'cheque' });
    expect(billing.getDefaultPaymentMethod).toHaveBeenCalledWith(
      'elite-craft',
    );
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: false });
    await expect(route.getDefaultPaymentMethod({})).rejects.toMatchObject({
      status: 401,
    });
    expect(billing.getDefaultPaymentMethod).not.toHaveBeenCalled();
  });
});

describe('PUT /api/v1/billing/payment-method (billing/12)', () => {
  it('sets the builder\u2019s default with the session tenant key', async () => {
    const { route, billing } = makeDeps();
    const result = await route.setDefaultPaymentMethod({}, { method: 'cheque' });
    expect(result).toEqual({ defaultMethod: 'cheque' });
    expect(billing.setDefaultPaymentMethod).toHaveBeenCalledWith(
      'elite-craft',
      'cheque',
    );
  });

  it('rejects an unknown method with 400 before touching the service', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.setDefaultPaymentMethod({}, { method: 'bitcoin' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.setDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: false });
    await expect(
      route.setDefaultPaymentMethod({}, { method: 'cheque' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(billing.setDefaultPaymentMethod).not.toHaveBeenCalled();
  });
});

describe('PUT /api/v1/billing/invoices/{id}/payment-method (billing/12)', () => {
  const id = '00000000-0000-4000-8000-000000000012';

  it('delegates with the session tenant key, invoice id, and method', async () => {
    const { route, billing } = makeDeps();
    const result = await route.setInvoicePaymentMethod(
      {},
      id,
      { method: 'e_transfer' },
    );
    expect(billing.setInvoicePaymentMethod).toHaveBeenCalledWith(
      id,
      'elite-craft',
      'e_transfer',
    );
    expect(result).toMatchObject({ id, paymentMethod: 'e_transfer' });
  });

  it('rejects an unknown method with 400 before touching the service', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.setInvoicePaymentMethod({}, id, { method: 'bitcoin' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.setInvoicePaymentMethod).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id with 400', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.setInvoicePaymentMethod({}, 'nope', { method: 'cheque' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.setInvoicePaymentMethod).not.toHaveBeenCalled();
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: false });
    await expect(
      route.setInvoicePaymentMethod({}, id, { method: 'cheque' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(billing.setInvoicePaymentMethod).not.toHaveBeenCalled();
  });
});
