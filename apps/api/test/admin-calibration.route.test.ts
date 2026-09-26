/**
 * Admin calibration-console route tests (admin/09).
 *
 * The route is thin: admin guard → one service method → response shape.
 * Real business logic lives in the service (covered by
 * admin-calibration.service.test.ts).
 *
 * AC4: admin-auth required; non-admin → 401 (login).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminCalibrationRoute,
  type AdminCalibrationRouteDeps,
} from '../src/routes/admin-calibration.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { AdminCalibrationService } from '../src/services/admin-calibration.service';
import type { AdminCalibrationResponse } from '@feasly/contracts';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };
const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';

const CALIBRATION_RESPONSE: AdminCalibrationResponse = {
  current: {
    version: 'v0.3.0-unclibrated',
    calibrated: false,
    frozen: false,
    source: 'placeholder stand-ins (uncalibrated)',
    notes: 'test',
    hardCostCategories: 8,
    softCostCategories: 5,
    tiers: ['standard', 'premium', 'luxury'],
  },
  report: {
    costDataVersion: 'v0.3.0-unclibrated',
    houses: [],
    errorDistribution: { buckets: [], counts: [] },
    sampleSize: 0,
    smallSampleWarning: 'No calibration data yet.',
    meanAbsoluteErrorFraction: null,
  },
  importHistory: [],
  hasDraftV2: false,
};

function makeDeps(): AdminCalibrationRouteDeps {
  const service: AdminCalibrationService = {
    getCalibration: vi.fn().mockResolvedValue(CALIBRATION_RESPONSE),
  };
  return {
    adminCalibration: service,
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
            'Admin authentication required.',
            false,
          );
        }
      },
      async getAdminEmail(
        headers: Record<string, string | string[] | undefined>,
      ) {
        const cookie = headers['cookie'];
        const value = Array.isArray(cookie) ? cookie[0] : cookie;
        return value === 'feasly_admin_session=valid-test-session'
          ? ADMIN_EMAIL
          : null;
      },
    },
  };
}

describe('admin-calibration.route', () => {
  it('AC4: returns the calibration payload for an authenticated admin', async () => {
    const deps = makeDeps();
    const route = createAdminCalibrationRoute(deps);

    const res = await route.get(ADMIN_HEADERS);

    expect(res).toEqual(CALIBRATION_RESPONSE);
    expect(deps.adminCalibration.getCalibration).toHaveBeenCalledWith(ADMIN_EMAIL);
  });

  it('AC4: non-admin requests are rejected with 401', async () => {
    const route = createAdminCalibrationRoute(makeDeps());

    await expect(route.get({})).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
    await expect(
      route.get({ cookie: 'feasly_admin_session=bogus' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
