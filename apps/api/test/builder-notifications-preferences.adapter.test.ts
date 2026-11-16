/**
 * #725 — GET + PUT /api/v1/builder/notifications/preferences.
 *
 * The real Azure Functions entry point through the real builder-leads
 * dispatcher with the REAL thin route (fake guard + fake service, no DB):
 * method routing, registry permission enforcement on the registry path,
 * and 401 without a builder session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuilderNotificationsRoute } from '../src/routes/builder/notifications.route';

const enforceRoutePermissions = vi.fn(async () => {});
let authed = true;

const fakeApp: Record<string, unknown> = {
  requestPipeline: {
    run: async (_input: unknown, handler: (ctx: unknown) => Promise<unknown>) => {
      try {
        return await handler({});
      } catch (error) {
        const e = error as { status?: number; code?: string; message?: string };
        return {
          status: e.status ?? 500,
          code: e.code ?? 'INTERNAL_ERROR',
          title: 'Notifications adapter test problem',
          detail: e.message ?? 'unknown',
          correlationId: 'test-correlation-id',
        };
      }
    },
  },
  permissionGuard: {},
  builderGuard: {
    requireBuilder: async () => {
      if (!authed) {
        throw Object.assign(new Error('Builder authentication required.'), {
          status: 401,
          code: 'UNAUTHENTICATED',
        });
      }
    },
  },
  builderNotificationsRoute: null,
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
    toProblemDetails: (e: { status?: number; code?: string; message?: string }) => ({
      status: e.status ?? 500,
      code: e.code ?? 'INTERNAL_ERROR',
      title: 'problem',
      detail: e.message ?? '',
      correlationId: 'test-correlation-id',
    }),
    isProblemDetails: (result: unknown) =>
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      'code' in result &&
      'title' in result,
  },
}));

// Imported after the mock.
import { builderNotificationsPreferencesHandler } from '../src/functions/builder-notifications-preferences';

const RESPONSE = {
  channel: 'email',
  preferences: { newLeadEmail: false, needsYouDigest: false, billingEmail: true },
  role: 'builder_member',
  canDisableBillingEmail: true,
};
const PATH = '/api/v1/builder/notifications/preferences';

function wire() {
  const getPreferences = vi.fn(async () => RESPONSE as never);
  const updatePreferences = vi.fn(async () => RESPONSE as never);
  fakeApp['builderNotificationsRoute'] = createBuilderNotificationsRoute({
    notifications: { getPreferences, updatePreferences },
    builderGuard: {
      getBuilderSession: async () =>
        ({ email: 'member@elite.example', tenantKey: 'elite', builderId: 'b1', viewAs: null }) as never,
    },
  });
  return { getPreferences, updatePreferences };
}

function ctx() {
  return { res: undefined as unknown, log: () => {}, bindingData: {} };
}

describe('builder-notifications-preferences adapter (#725)', () => {
  beforeEach(() => {
    authed = true;
    vi.clearAllMocks();
  });

  it('GET returns the preferences and enforces the registry path', async () => {
    const { getPreferences, updatePreferences } = wire();
    const context = ctx();
    await builderNotificationsPreferencesHandler(context, { method: 'GET', headers: {} });
    expect(getPreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({ status: 200, body: RESPONSE });
    expect(enforceRoutePermissions).toHaveBeenCalledWith(
      fakeApp['permissionGuard'],
      'GET',
      PATH,
      expect.anything(),
    );
  });

  it('PUT forwards the body to the update', async () => {
    const { updatePreferences } = wire();
    const context = ctx();
    await builderNotificationsPreferencesHandler(context, {
      method: 'PUT',
      headers: {},
      body: { newLeadEmail: false },
    });
    expect(updatePreferences).toHaveBeenCalledWith(expect.anything(), { newLeadEmail: false });
    expect(enforceRoutePermissions).toHaveBeenCalledWith(
      fakeApp['permissionGuard'],
      'PUT',
      PATH,
      expect.anything(),
    );
    expect(context.res).toMatchObject({ status: 200 });
  });

  it('401 problem without a builder session; the service is never called', async () => {
    authed = false;
    const { getPreferences } = wire();
    const context = ctx();
    await builderNotificationsPreferencesHandler(context, { method: 'GET', headers: {} });
    expect(getPreferences).not.toHaveBeenCalled();
    expect(context.res).toMatchObject({
      status: 401,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  });
});
