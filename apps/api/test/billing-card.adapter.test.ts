/**
 * #716 adapter tests — GET + DELETE /api/v1/billing/card.
 *
 * Exercises the real Functions entry point through the real shared dispatch
 * with a REAL billing route (fake guard + fake card service, no DB). Pins:
 * - GET vs DELETE branching (function.json binds both to one adapter).
 * - Registry permissions are enforced centrally for DELETE with the
 *   DELETE method + registry path — a builder member's 403 comes from
 *   `builder:billing` (builder_admin only) before the route runs.
 * - 401 problem without a builder session; 409 passes through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoute } from '../src/routes/billing.route';
import type { BillingService } from '../src/services/billing/billing.service';
import type { BuilderGuard } from '../src/middleware/builder-guard';
import type { AdminGuard } from '../src/middleware/admin-guard';
import type { InvoicePdfService } from '../src/services/billing/invoice-pdf.service';
import type { CommissionCardService } from '../src/services/billing/commission-card.service';

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
        const e = error as { status?: number; code?: string; message?: string };
        return {
          status: e.status ?? 500,
          code: e.code ?? 'INTERNAL_ERROR',
          title: 'Billing card adapter test problem',
          detail: e.message ?? 'unknown',
          correlationId: 'test-correlation-id',
        };
      }
    },
  },
  permissionGuard: {},
  billingRoute: null,
};

const enforceRoutePermissions = vi.fn(
  async (_guard: unknown, _method: string | undefined, _path: string) => {},
);

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: ['https://example.com'] }),
  middleware: {
    resolveCorsHeaders: () => ({}),
    securityHeaders: () => ({}),
    preflightHeaders: () => ({}),
    isPreflight: () => false,
    ensureCorrelationId: () => 'test-correlation-id',
    enforceRoutePermissions: (
      guard: unknown,
      method: string | undefined,
      path: string,
    ) => enforceRoutePermissions(guard, method, path),
    isProblemDetails: (result: unknown) =>
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      'code' in result &&
      'title' in result,
  },
}));

// Imported after the mock.
import { billingCardHandler } from '../src/functions/billing-card';

let authed = true;

function makeContext() {
  return { res: undefined as unknown, log: () => {}, bindingData: {} };
}

function makeReq(method: string) {
  return { method, headers: { authorization: 'Bearer builder-session-token' } };
}

function wire(opts?: { readonly blocked?: boolean }) {
  const commissionCard = {
    getCard: vi.fn(async () => ({ hasCard: true, brand: 'visa', last4: '4242' })),
    removeCard: vi.fn(async () => {
      if (opts?.blocked) {
        throw Object.assign(new Error('invoice INV-0042 is set to be charged to it'), {
          status: 409,
          code: 'CONFLICT',
        });
      }
      return { hasCard: false };
    }),
  } as unknown as CommissionCardService;
  fakeApp.billingRoute = createBillingRoute({
    billing: {} as unknown as BillingService,
    commissionCard,
    invoicePdf: {} as unknown as InvoicePdfService,
    builderGuard: {
      getBuilderSession: async () =>
        authed ? { email: 'builder@example.com', tenantKey: 'elite-craft' } : null,
    } as unknown as BuilderGuard,
    adminGuard: {} as unknown as AdminGuard,
  });
  return { commissionCard };
}

describe('billing-card adapter (#716)', () => {
  beforeEach(() => {
    authed = true;
    vi.clearAllMocks();
    enforceRoutePermissions.mockImplementation(async () => {});
  });

  it('GET reads the card', async () => {
    const { commissionCard } = wire();
    const context = makeContext();
    await billingCardHandler(context, makeReq('GET'));
    expect(context.res).toMatchObject({ status: 200, body: { hasCard: true } });
    expect(commissionCard.getCard).toHaveBeenCalledWith('elite-craft');
    expect(commissionCard.removeCard).not.toHaveBeenCalled();
  });

  it('DELETE removes the card, after the registry permission check for DELETE', async () => {
    const { commissionCard } = wire();
    const context = makeContext();
    await billingCardHandler(context, makeReq('DELETE'));
    expect(context.res).toMatchObject({ status: 200, body: { hasCard: false } });
    expect(commissionCard.removeCard).toHaveBeenCalledWith('elite-craft');
    expect(enforceRoutePermissions).toHaveBeenCalledWith(
      expect.anything(),
      'DELETE',
      '/api/v1/billing/card',
    );
  });

  it('DELETE is 403 for a builder member (registry permission) and never reaches the service', async () => {
    const { commissionCard } = wire();
    enforceRoutePermissions.mockImplementation(async () => {
      throw Object.assign(new Error('Missing permission builder:billing'), {
        status: 403,
        code: 'FORBIDDEN',
      });
    });
    const context = makeContext();
    await billingCardHandler(context, makeReq('DELETE'));
    expect(context.res).toMatchObject({ status: 403 });
    expect(commissionCard.removeCard).not.toHaveBeenCalled();
  });

  it('DELETE is 401 without a session', async () => {
    authed = false;
    const { commissionCard } = wire();
    const context = makeContext();
    await billingCardHandler(context, makeReq('DELETE'));
    expect(context.res).toMatchObject({ status: 401 });
    expect(commissionCard.removeCard).not.toHaveBeenCalled();
  });

  it('DELETE passes the unpaid-invoice 409 through as a problem', async () => {
    wire({ blocked: true });
    const context = makeContext();
    await billingCardHandler(context, makeReq('DELETE'));
    expect(context.res).toMatchObject({
      status: 409,
      body: { code: 'CONFLICT', detail: expect.stringContaining('INV-0042') },
    });
  });
});
