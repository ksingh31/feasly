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
