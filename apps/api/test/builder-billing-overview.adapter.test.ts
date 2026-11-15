/**
 * #531 — GET /api/v1/builder/billing/overview.
 *
 * Exercises the real Azure Functions entry point through the real shared
 * billing dispatch with a REAL thin route (fake guard + fake overview
 * service, no DB). Pins the HTTP surface:
 * - 200 with the overview, tenant key taken from the builder session.
 * - 401 problem without a builder session (service never touched).
 * - 403 problem when the registry permission check rejects the role
 *   (`builder:billing`), enforced against the registry path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuilderBillingOverviewResponse } from '@feasly/contracts';
import { createBuilderBillingOverviewRoute } from '../src/routes/builder/billing-overview.route';
import type { BillingOverviewService } from '../src/services/billing/billing-overview.service';
import type { BuilderGuard } from '../src/middleware/builder-guard';

type BuilderSession = NonNullable<Awaited<ReturnType<BuilderGuard['getBuilderSession']>>>;

const enforceRoutePermissions = vi.fn(async () => {});

const fakeApp: {
  requestPipeline: {
    run: (
      input: unknown,
      handler: (ctx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  permissionGuard: unknown;
  builderBillingOverviewRoute: unknown;
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
          title: 'Billing overview adapter test problem',
          detail: e.message ?? 'unknown',
          correlationId: 'test-correlation-id',
        };
      }
    },
  },
  permissionGuard: {},
  builderBillingOverviewRoute: null,
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
    enforceRoutePermissions: (...args: unknown[]) =>
      (enforceRoutePermissions as (...a: unknown[]) => Promise<void>)(...args),
    isProblemDetails: (result: unknown) =>
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      'code' in result &&
      'title' in result,
  },
}));

// Imported after the mock.
import { builderBillingOverviewHandler } from '../src/functions/builder-billing-overview';

const OVERVIEW: BuilderBillingOverviewResponse = {
  planType: 'commission',
  commissionRatePercent: 1,
  currency: 'CAD',
  outstandingCents: 750_000,
  outstandingCount: 2,
  nextCharge: {
    invoiceId: 'inv-1',
    invoiceNumber: 'INV-0001',
    amountCents: 500_000,
    chargeAt: '2026-11-20T00:00:00.000Z',
    cardLast4: '4242',
  },
  failedCount: 1,
  failedInvoices: [
    { id: 'inv-2', invoiceNumber: 'INV-0002', leadId: 'lead-2', commissionCents: 250_000 },
  ],
  disputedCount: 0,
  card: { hasCard: true, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
};

let authed = true;

function makeContext() {
  return { res: undefined as unknown, log: () => {}, bindingData: {} };
}

function makeReq() {
  return {
    method: 'GET',
    headers: { authorization: 'Bearer builder-session-token' },
  };
}

function wireRoute(): { overview: BillingOverviewService } {
  const overview: BillingOverviewService = {
    getOverview: vi.fn(async () => OVERVIEW),
  };
  fakeApp.builderBillingOverviewRoute = createBuilderBillingOverviewRoute({
    overview,
    builderGuard: {
      getBuilderSession: async () =>
        authed
          ? ({ email: 'builder@example.com', tenantKey: 'elite-craft' } as unknown as BuilderSession)
          : null,
    },
  });
  return { overview };
}

describe('builder-billing-overview adapter (#531)', () => {
  beforeEach(() => {
    authed = true;
    vi.clearAllMocks();
    enforceRoutePermissions.mockImplementation(async () => {});
  });

  it('returns the overview for the session tenant in one call', async () => {
    const { overview } = wireRoute();
    const context = makeContext();
    await builderBillingOverviewHandler(context, makeReq());

    expect(overview.getOverview).toHaveBeenCalledTimes(1);
    expect(overview.getOverview).toHaveBeenCalledWith('elite-craft');
    expect(context.res).toMatchObject({ status: 200, body: OVERVIEW });
  });

  it('enforces registry permissions against the overview path', async () => {
    wireRoute();
    await builderBillingOverviewHandler(makeContext(), makeReq());
    expect(enforceRoutePermissions).toHaveBeenCalledWith(
      fakeApp.permissionGuard,
      'GET',
      '/api/v1/builder/billing/overview',
      expect.anything(),
    );
  });

  it('returns a 401 problem without a builder session', async () => {
    authed = false;
    const { overview } = wireRoute();
    const context = makeContext();
    await builderBillingOverviewHandler(context, makeReq());

    expect(overview.getOverview).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({
      status: 401,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  });

  it('returns a 403 problem when the role lacks builder:billing', async () => {
    enforceRoutePermissions.mockImplementation(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
    });
    const { overview } = wireRoute();
    const context = makeContext();
    await builderBillingOverviewHandler(context, makeReq());

    expect(overview.getOverview).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({ status: 403 });
  });
});
