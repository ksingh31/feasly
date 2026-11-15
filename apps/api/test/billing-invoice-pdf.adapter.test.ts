/**
 * #661 adapter test: GET /api/v1/billing/invoices/{id}/pdf through the
 * real Functions entry point, real shared dispatch, real billing route and
 * real invoice PDF service (fake billing/card/builder deps, no DB).
 * Pins: raw application/pdf bytes + attachment header, and a 404 problem
 * for another tenant's invoice id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoute } from '../src/routes/billing.route';
import { createInvoicePdfService } from '../src/services/billing/invoice-pdf.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { BillingService } from '../src/services/billing/billing.service';
import type { BuilderGuard } from '../src/middleware/builder-guard';
import type { AdminGuard } from '../src/middleware/admin-guard';
import type { CommissionCardService } from '../src/services/billing/commission-card.service';

interface FakeProblem {
  status: number;
  code: string;
  title: string;
  detail: string;
  correlationId: string;
}

// The adapter binds `createComposition` lazily via getApp(), but the module
// import itself must see the mocked barrel — same pattern as the
// sheets-sync timer adapter test. `loadConfig` and `middleware` come from
// the same barrel, so they need fakes too.
const fakeApp: {
  requestPipeline: {
    run: (
      input: unknown,
      handler: (ctx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  permissionGuard: unknown;
  billingRoute: unknown;
} = {
  requestPipeline: {
    run: async (_input, handler) => {
      try {
        return await handler({});
      } catch (error) {
        const e = error as {
          status?: number;
          code?: string;
          message?: string;
        };
        const problem: FakeProblem = {
          status: e.status ?? 500,
          code: e.code ?? 'INTERNAL_ERROR',
          title: 'Billing adapter test problem',
          detail: e.message ?? 'unknown',
          correlationId: 'test-correlation-id',
        };
        return problem;
      }
    },
  },
  permissionGuard: {},
  billingRoute: null,
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: ['https://example.com'] }),
  middleware: {
    resolveCorsHeaders: () => ({}),
    securityHeaders: () => ({}),
    preflightHeaders: () => ({}),
    isPreflight: () => false,
    ensureCorrelationId: () => 'test-correlation-id',
    enforceRoutePermissions: async () => {},
    isProblemDetails: (result: unknown) =>
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      'code' in result &&
      'title' in result,
  },
}));

// Imported after the mock.
import { billingInvoicePdfHandler } from '../src/functions/billing-invoice-pdf';

const INVOICE_ID = '00000000-0000-4000-8000-000000000041';
let sessionTenant: string | null = 'elite-craft';

function wireRoute(): void {
  const record = {
    id: INVOICE_ID,
    tenantKey: 'elite-craft',
    leadName: 'Jordan',
    contractValueCents: 50_000_000,
    commissionCents: 500_000,
    status: 'paid',
    reviewDueAt: null,
    paidAt: new Date('2026-11-14T18:00:00Z'),
    effectiveRatePercent: 1,
    manualPaymentMethod: null,
    paymentReference: null,
    invoiceNumber: 'INV-0042',
    paymentMethod: 'card',
    createdAt: new Date('2026-11-13T18:00:00Z'),
  };
  const billing = {
    getInvoice: vi.fn(async (_id: string, tenantKey: string | null) => {
      if (tenantKey !== null && tenantKey !== record.tenantKey) {
        throw new HttpError(403, ErrorCodes.FORBIDDEN, 'This invoice belongs to a different builder.');
      }
      return record;
    }),
  } as unknown as BillingService;
  const commissionCard = {
    getCard: vi.fn(async () => ({ hasCard: true, brand: 'visa', last4: '4242' })),
  } as unknown as CommissionCardService;
  const builderGuard = {
    getBuilderSession: async () =>
      sessionTenant ? { email: 'builder@example.com', tenantKey: sessionTenant } : null,
  } as unknown as BuilderGuard;
  const adminGuard = {
    requireAdmin: async () => {
      throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.');
    },
  } as unknown as AdminGuard;
  fakeApp.billingRoute = createBillingRoute({
    billing,
    commissionCard,
    invoicePdf: createInvoicePdfService({
      billing,
      commissionCard,
      builders: { getByTenantKey: async () => null },
    }),
    builderGuard,
    adminGuard,
  });
}

function call(id: string) {
  const context = {
    res: undefined as unknown,
    log: () => {},
    bindingData: { id } as Record<string, unknown>,
  };
  return billingInvoicePdfHandler(context, {
    method: 'GET',
    headers: { cookie: 'feasly_builder=session' },
  }).then(() => context.res as {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    isRaw?: boolean;
  });
}

describe('billing-invoice-pdf adapter (#661)', () => {
  beforeEach(() => {
    sessionTenant = 'elite-craft';
    wireRoute();
  });

  it('returns raw PDF bytes as an attachment for the builder\'s own invoice', async () => {
    const res = await call(INVOICE_ID);
    expect(res.status).toBe(200);
    expect(res.isRaw).toBe(true);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="feasly-INV-0042.pdf"');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    const s = (res.body as Buffer).toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('(Receipt)');
  });

  it("returns a 404 problem for another tenant's invoice id", async () => {
    sessionTenant = 'other-builder';
    const res = await call(INVOICE_ID);
    expect(res.status).toBe(404);
    expect(res.headers['Content-Type']).toBe('application/problem+json');
  });

  it('returns a 401 problem without a session', async () => {
    sessionTenant = null;
    const res = await call(INVOICE_ID);
    expect(res.status).toBe(401);
  });

  it('returns a 400 problem for a non-uuid id', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(400);
  });
});
