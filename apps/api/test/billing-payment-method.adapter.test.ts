/**
 * billing/12 adapter tests.
 *
 * Exercises the real Azure Functions entry points
 * (`billing-payment-method`, `billing-invoice-payment-method`) through the
 * real shared dispatch with a REAL billing route (fake guard + fake billing
 * service, no DB). Pins the HTTP surface:
 * - GET vs PUT branching on `/api/v1/billing/payment-method` (the
 *   function.json binds both methods to one adapter).
 * - `{id}` route-parameter plumbing to the invoice adapter.
 * - zod body validation → 400 problem before the service is touched.
 * - 401 problem without a builder session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoute } from '../src/routes/billing.route';
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
import { billingPaymentMethodHandler } from '../src/functions/billing-payment-method';
import { billingInvoicePaymentMethodHandler } from '../src/functions/billing-invoice-payment-method';

const INVOICE_ID = '00000000-0000-4000-8000-000000000021';

let authed = true;

function makeContext() {
  return {
    res: undefined as unknown,
    log: () => {},
    bindingData: {} as Record<string, unknown>,
  };
}

function makeReq(
  method: string,
  body?: unknown,
): { method: string; headers: Record<string, string>; body?: unknown } {
  return {
    method,
    headers: { authorization: 'Bearer builder-session-token' },
    body,
  };
}

function wireRoute(): {
  billing: BillingService;
} {
  const billing = {
    getDefaultPaymentMethod: vi.fn(async () => 'cheque' as const),
    setDefaultPaymentMethod: vi.fn(
      async (_tenantKey: string, method: 'card' | 'cheque' | 'e_transfer' | 'bank_draft') => method,
    ),
    setInvoicePaymentMethod: vi.fn(
      async (
        invoiceId: string,
        tenantKey: string,
        method: 'card' | 'cheque' | 'e_transfer' | 'bank_draft',
      ) => ({ id: invoiceId, tenantKey, paymentMethod: method }),
    ),
  } as unknown as BillingService;
  const builderGuard = {
    getBuilderSession: async () =>
      authed
        ? { email: 'builder@example.com', tenantKey: 'elite-craft' }
        : null,
  } as unknown as BuilderGuard;
  fakeApp.billingRoute = createBillingRoute({
    billing,
    commissionCard: {} as unknown as CommissionCardService,
    builderGuard,
    adminGuard: {} as unknown as AdminGuard,
  });
  return { billing };
}

describe('billing-payment-method adapter (billing/12)', () => {
  beforeEach(() => {
    authed = true;
    vi.clearAllMocks();
  });

  it('GET returns the default payment method', async () => {
    const { billing } = wireRoute();
    const context = makeContext();
    await billingPaymentMethodHandler(context, makeReq('GET'));

    expect(billing.getDefaultPaymentMethod).toHaveBeenCalledWith('elite-craft');
    expect(context.res).toMatchObject({
      status: 200,
      body: { defaultMethod: 'cheque' },
    });
  });

  it('PUT sets the default payment method', async () => {
    const { billing } = wireRoute();
    const context = makeContext();
    await billingPaymentMethodHandler(context, makeReq('PUT', { method: 'e_transfer' }));

    expect(billing.setDefaultPaymentMethod).toHaveBeenCalledWith(
      'elite-craft',
      'e_transfer',
    );
    expect(context.res).toMatchObject({
      status: 200,
      body: { defaultMethod: 'e_transfer' },
    });
  });

  it('PUT with an unknown method returns a 400 problem and never reaches the service', async () => {
    const { billing } = wireRoute();
    const context = makeContext();
    await billingPaymentMethodHandler(context, makeReq('PUT', { method: 'bitcoin' }));

    expect(billing.setDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({
      status: 400,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  });

  it('returns a 401 problem without a builder session', async () => {
    authed = false;
    const { billing } = wireRoute();
    const context = makeContext();
    await billingPaymentMethodHandler(context, makeReq('GET'));

    expect(billing.getDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({ status: 401 });
  });
});

describe('billing-invoice-payment-method adapter (billing/12)', () => {
  beforeEach(() => {
    authed = true;
    vi.clearAllMocks();
  });

  it('PUT plumbs the {id} route parameter and body to the service', async () => {
    const { billing } = wireRoute();
    const context = makeContext();
    context.bindingData = { id: INVOICE_ID };
    await billingInvoicePaymentMethodHandler(
      context,
      makeReq('PUT', { method: 'bank_draft' }),
    );

    expect(billing.setInvoicePaymentMethod).toHaveBeenCalledWith(
      INVOICE_ID,
      'elite-craft',
      'bank_draft',
    );
    expect(context.res).toMatchObject({
      status: 200,
      body: { id: INVOICE_ID, paymentMethod: 'bank_draft' },
    });
  });

  it('PUT with an unknown method returns a 400 problem and never reaches the service', async () => {
    const { billing } = wireRoute();
    const context = makeContext();
    context.bindingData = { id: INVOICE_ID };
    await billingInvoicePaymentMethodHandler(
      context,
      makeReq('PUT', { method: 'barter' }),
    );

    expect(billing.setInvoicePaymentMethod).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({ status: 400 });
  });

  it('returns a 401 problem without a builder session', async () => {
    authed = false;
    const { billing } = wireRoute();
    const context = makeContext();
    context.bindingData = { id: INVOICE_ID };
    await billingInvoicePaymentMethodHandler(
      context,
      makeReq('PUT', { method: 'cheque' }),
    );

    expect(billing.setInvoicePaymentMethod).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({ status: 401 });
  });
});
