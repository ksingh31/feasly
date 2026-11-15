/**
 * Builder agreement + onboarding route (#722) — services stubbed.
 *
 * Thin route: permission guard (401 unauthenticated / 403 wrong role come
 * from it) → session builder id → one service call. Accept validates the
 * body and passes the #729 client IP and the user agent.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgreementStatus, BuilderOnboardingStatus } from '@feasly/contracts';
import { createBuilderAgreementRoute } from '../src/routes/builder/agreement.route';
import type { BuilderAgreementService } from '../src/services/builder-agreement.service';
import type { BuilderOnboardingService } from '../src/services/builder-onboarding.service';
import type { PermissionGuard } from '../src/middleware/permission-guard';
import type { AuthContext } from '../src/services/auth-context.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { userId: 'u-1', builderId: BUILDER_ID } as unknown as AuthContext;
const STATUS = { version: 'v1', current: false } as AgreementStatus;
const ONBOARDING = { complete: false } as BuilderOnboardingStatus;

function make(guard?: Partial<PermissionGuard>) {
  const agreements = {
    getStatus: vi.fn(async () => STATUS),
    accept: vi.fn(async () => ({ ...STATUS, current: true })),
  } as unknown as BuilderAgreementService;
  const onboarding = {
    getStatus: vi.fn(async () => ONBOARDING),
  } as unknown as BuilderOnboardingService;
  const permissionGuard = {
    requirePermission: vi.fn(async () => CTX),
    requireBuilderId: vi.fn(async () => BUILDER_ID),
    ...guard,
  } as unknown as PermissionGuard;
  const route = createBuilderAgreementRoute({ agreements, onboarding, permissionGuard });
  return { route, agreements, onboarding, permissionGuard };
}

describe('builder agreement route (#722)', () => {
  it('GET agreement: session-scoped status', async () => {
    const { route, agreements, permissionGuard } = make();
    await expect(route.getAgreement({})).resolves.toBe(STATUS);
    expect(permissionGuard.requirePermission).toHaveBeenCalledWith(
      'builder:leads:read',
      {},
      'GET /api/v1/builder/agreement',
    );
    expect(agreements.getStatus).toHaveBeenCalledWith(CTX, BUILDER_ID);
  });

  it('POST accept passes version, the right-most XFF hop and the user agent', async () => {
    const { route, agreements } = make();
    const headers = {
      'x-forwarded-for': '198.51.100.1, 203.0.113.7',
      'User-Agent': 'Mozilla/5.0 test',
    };
    const result = await route.accept(headers, { version: 'v1' });
    expect(result.current).toBe(true);
    expect(agreements.accept).toHaveBeenCalledWith(CTX, BUILDER_ID, {
      version: 'v1',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 test',
    });
  });

  it('POST accept without IP/UA headers records nulls', async () => {
    const { route, agreements } = make();
    await route.accept({}, { version: 'v1' });
    expect(agreements.accept).toHaveBeenCalledWith(CTX, BUILDER_ID, {
      version: 'v1',
      ip: null,
      userAgent: null,
    });
  });

  it('POST accept 400s on a missing version', async () => {
    const { route, agreements } = make();
    await expect(route.accept({}, {})).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(agreements.accept).not.toHaveBeenCalled();
  });

  it('member accept: the service 403 AGREEMENT_ADMIN_REQUIRED propagates', async () => {
    const { route, agreements } = make();
    vi.mocked(agreements.accept).mockRejectedValueOnce(
      new HttpError(403, 'AGREEMENT_ADMIN_REQUIRED', 'Only an admin…', false),
    );
    await expect(route.accept({}, { version: 'v1' })).rejects.toMatchObject({
      status: 403,
      code: 'AGREEMENT_ADMIN_REQUIRED',
    });
  });

  it('GET onboarding: session-scoped checklist', async () => {
    const { route, onboarding } = make();
    await expect(route.getOnboarding({})).resolves.toBe(ONBOARDING);
    expect(onboarding.getStatus).toHaveBeenCalledWith(CTX, BUILDER_ID);
  });

  it('401 unauthenticated on every endpoint (guard rejects, services untouched)', async () => {
    const { route, agreements, onboarding } = make({
      requirePermission: vi.fn(async () => {
        throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Authentication required.', false);
      }),
    });
    await expect(route.getAgreement({})).rejects.toMatchObject({ status: 401 });
    await expect(route.accept({}, { version: 'v1' })).rejects.toMatchObject({ status: 401 });
    await expect(route.getOnboarding({})).rejects.toMatchObject({ status: 401 });
    expect(agreements.getStatus).not.toHaveBeenCalled();
    expect(agreements.accept).not.toHaveBeenCalled();
    expect(onboarding.getStatus).not.toHaveBeenCalled();
  });

  it('403 for a role without builder access (e.g. staff viewer)', async () => {
    const { route, agreements } = make({
      requirePermission: vi.fn(async () => {
        throw new HttpError(403, ErrorCodes.FORBIDDEN, 'No access.', false);
      }),
    });
    await expect(route.accept({}, { version: 'v1' })).rejects.toMatchObject({ status: 403 });
    expect(agreements.accept).not.toHaveBeenCalled();
  });
});
