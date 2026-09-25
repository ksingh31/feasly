/**
 * Admin estimate-lookup route tests (admin/03).
 *
 * The route is a thin adapter: validate the id → require admin → delegate to
 * the service. Guards and service behavior are covered in their own tests;
 * this file asserts the wiring, the 400 on a malformed id, and that the
 * route calls the guard before the service.
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes } from '../src/middleware/errors';
import { createAdminEstimatesRoute } from '../src/routes/admin-estimates.route';
import type { AdminGuard } from '../src/middleware/admin-guard';
import type { AdminEstimatesService } from '../src/services/admin-estimates.service';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeRoute(overrides?: {
  guard?: Partial<AdminGuard>;
  service?: Partial<AdminEstimatesService>;
}) {
  const requireAdmin = vi.fn(async () => {});
  const getEstimate = vi.fn(async () => ({ id: ESTIMATE_ID }) as never);
  const route = createAdminEstimatesRoute({
    adminGuard: { requireAdmin, ...(overrides?.guard ?? {}) } as AdminGuard,
    adminEstimates: { getEstimate, ...(overrides?.service ?? {}) } as AdminEstimatesService,
  });
  return { route, requireAdmin, getEstimate };
}

describe('admin/03 estimate lookup route', () => {
  it('requires admin before calling the service', async () => {
    const { route, requireAdmin, getEstimate } = makeRoute();
    const headers = { cookie: 'admin_session=abc' };

    await route.get(headers, ESTIMATE_ID);

    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(requireAdmin).toHaveBeenCalledWith(headers);
    expect(getEstimate).toHaveBeenCalledTimes(1);
    expect(getEstimate).toHaveBeenCalledWith(ESTIMATE_ID);
  });

  it('propagates the guard rejection (401) without touching the service', async () => {
    const forbidden = Object.assign(new Error('nope'), {
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    const { route, getEstimate } = makeRoute({
      guard: { requireAdmin: async () => { throw forbidden; } },
    });

    await expect(route.get({}, ESTIMATE_ID)).rejects.toBe(forbidden);
    expect(getEstimate).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 VALIDATION_FAILED', async () => {
    const { route, getEstimate } = makeRoute();

    const error = await route.get({}, 'not-a-uuid').catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(getEstimate).not.toHaveBeenCalled();
  });

  it('rejects an empty id with 400 VALIDATION_FAILED', async () => {
    const { route, getEstimate } = makeRoute();

    const error = await route.get({}, '').catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(getEstimate).not.toHaveBeenCalled();
  });

  it('propagates the service 404 ESTIMATE_NOT_FOUND', async () => {
    const notFound = Object.assign(new Error('missing'), {
      status: 404,
      code: ErrorCodes.ESTIMATE_NOT_FOUND,
    });
    const { route } = makeRoute({
      service: { getEstimate: async () => { throw notFound; } },
    });

    await expect(route.get({}, ESTIMATE_ID)).rejects.toBe(notFound);
  });
});
