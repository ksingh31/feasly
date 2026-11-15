/**
 * Issue #530 — members can "Mark won"; recording the contract stays admin.
 *
 * Route layer (services stubbed):
 * - POST /api/v1/builder/leads/{id}/mark-won: 401 without a session, 400
 *   on a bad id, otherwise delegates to the service with the SESSION's
 *   tenant + email (never a request value).
 * - PATCH /api/v1/builder/leads/{id} with contract details requires
 *   `builder:billing` (403 for members); without them it doesn't check.
 *
 * Central enforcement (the registry gate every adapter runs):
 * - builder_member → 403 on POST /api/v1/billing/report-contract;
 * - builder_member → allowed on mark-won (and on plain status PATCH);
 * - builder_admin → allowed on report-contract and mark-won;
 * - no session → 401.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BuilderLeadMarkWonResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { enforceRoutePermissions } from '../src/middleware/enforce-route-permissions';
import {
  createPermissionGuard,
  type PermissionGuard,
  type PermissionGuardDeps,
} from '../src/middleware/permission-guard';
import { effectivePermissions } from '../src/auth/permissions';
import { createBuilderLeadsRoute } from '../src/routes/builder-leads.route';
import type { BuilderGuard } from '../src/middleware/builder-guard';
import type { BuilderLeadsService } from '../src/services/builder-leads.service';
import type { AuthContext } from '../src/services/auth-context.service';
import type { BuilderRole } from '../src/services/user.service';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const HEADERS = { authorization: 'Bearer <redacted>' };
const MARK_WON = '/api/v1/builder/leads/{id}/mark-won';
const STATUS = '/api/v1/builder/leads/{id}';
const REPORT_CONTRACT = '/api/v1/billing/report-contract';

const MARK_WON_RESULT: BuilderLeadMarkWonResponse = {
  ok: true,
  status: 'won',
  needsRecording: true,
  changed: true,
  adminsNotified: 1,
};

function makeRoute(opts?: {
  readonly session?: { email: string; tenantKey: string } | null;
  readonly billingAllowed?: boolean;
}) {
  const session =
    opts && 'session' in opts
      ? opts.session
      : { email: 'member@elite.example', tenantKey: 'elite-craft' };
  const builderGuard: BuilderGuard = {
    requireBuilder: async () => {},
    getBuilderSession: async () =>
      session ? { ...session, builderId: 'builder-1', viewAs: null } : null,
  };
  const builderLeads = {
    listLeads: vi.fn(),
    updateStatus: vi.fn(async () => ({ ok: true as const })),
    markWon: vi.fn(async () => MARK_WON_RESULT),
  } as unknown as BuilderLeadsService & {
    updateStatus: ReturnType<typeof vi.fn>;
    markWon: ReturnType<typeof vi.fn>;
  };
  const requirePermission = vi.fn(async () => {
    if (opts?.billingAllowed === false) {
      throw new HttpError(403, ErrorCodes.FORBIDDEN, 'No access.', false);
    }
    return {} as AuthContext;
  });
  const permissionGuard = {
    requirePermission,
  } as unknown as Pick<PermissionGuard, 'requirePermission'>;
  const route = createBuilderLeadsRoute({ builderLeads, builderGuard, permissionGuard });
  return { route, builderLeads, requirePermission };
}

describe('builder-leads route: mark-won (#530)', () => {
  it('delegates with the session tenant + email', async () => {
    const { route, builderLeads } = makeRoute();
    await expect(route.markWon(HEADERS, LEAD_ID)).resolves.toEqual(MARK_WON_RESULT);
    expect(builderLeads.markWon).toHaveBeenCalledWith(
      LEAD_ID,
      'elite-craft',
      'member@elite.example',
    );
  });

  it('401 without a builder session', async () => {
    const { route, builderLeads } = makeRoute({ session: null });
    await expect(route.markWon(HEADERS, LEAD_ID)).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
    expect(builderLeads.markWon).not.toHaveBeenCalled();
  });

  it('400 on a non-uuid lead id', async () => {
    const { route, builderLeads } = makeRoute();
    await expect(route.markWon(HEADERS, 'not-a-uuid')).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(builderLeads.markWon).not.toHaveBeenCalled();
  });
});

describe('builder-leads route: PATCH contract details need builder:billing (#530)', () => {
  it('403 for a member sending contract details — the service never runs', async () => {
    const { route, builderLeads, requirePermission } = makeRoute({ billingAllowed: false });
    await expect(
      route.updateStatus(HEADERS, LEAD_ID, {
        status: 'won',
        contractValueCents: 100_000_00,
        contractSignedAt: '2026-11-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 403, code: ErrorCodes.FORBIDDEN });
    expect(requirePermission).toHaveBeenCalledWith('builder:billing', HEADERS, STATUS);
    expect(builderLeads.updateStatus).not.toHaveBeenCalled();
  });

  it('a single contract field is enough to trigger the gate', async () => {
    const { route, requirePermission } = makeRoute({ billingAllowed: false });
    await expect(
      route.updateStatus(HEADERS, LEAD_ID, { status: 'won', contractValueCents: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(requirePermission).toHaveBeenCalledTimes(1);
  });

  it('an admin with builder:billing passes through to the service', async () => {
    const { route, builderLeads } = makeRoute({ billingAllowed: true });
    const body = {
      status: 'won',
      contractValueCents: 100_000_00,
      contractSignedAt: '2026-11-01T00:00:00.000Z',
    };
    await route.updateStatus(HEADERS, LEAD_ID, body);
    expect(builderLeads.updateStatus).toHaveBeenCalledWith(
      LEAD_ID,
      body,
      'elite-craft',
      'member@elite.example',
    );
  });

  it('plain status changes (incl. won) skip the billing gate', async () => {
    const { route, builderLeads, requirePermission } = makeRoute({ billingAllowed: false });
    await route.updateStatus(HEADERS, LEAD_ID, { status: 'won' });
    expect(requirePermission).not.toHaveBeenCalled();
    expect(builderLeads.updateStatus).toHaveBeenCalledTimes(1);
  });
});

function ctxFor(members: BuilderRole[]): AuthContext {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    name: 'User',
    staffRole: null,
    permissions: effectivePermissions(null, members),
    builderId: 'builder-1',
    builderName: 'Test Builder',
    memberships: members.map((role) => ({
      builderId: 'builder-1',
      role,
      createdAt: new Date('2026-11-01T00:00:00Z'),
    })),
    viewAs: null,
    realUser: null,
  };
}

function guardFor(ctx: AuthContext | null) {
  const auditDenied = vi.fn(async (_args: unknown) => {});
  const guard = createPermissionGuard({
    authContext: {
      resolve: async () => ctx,
      auditDenied,
      auditViewAsAction: vi.fn(async (_args: unknown) => {}),
    } as unknown as PermissionGuardDeps['authContext'],
  });
  return { guard, auditDenied };
}

describe('mark-won vs record-contract — central permission enforcement (#530)', () => {
  it('403s a builder_member on POST report-contract (audit-logged)', async () => {
    const { guard, auditDenied } = guardFor(ctxFor(['builder_member']));
    const err = await enforceRoutePermissions(guard, 'POST', REPORT_CONTRACT, HEADERS).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).code).toBe(ErrorCodes.FORBIDDEN);
    expect(auditDenied).toHaveBeenCalledTimes(1);
  });

  it('lets a builder_member mark a lead won', async () => {
    await expect(
      enforceRoutePermissions(guardFor(ctxFor(['builder_member'])).guard, 'POST', MARK_WON, HEADERS),
    ).resolves.toBeUndefined();
  });

  it('lets a builder_member change status via PATCH (contract details gated in the route)', async () => {
    await expect(
      enforceRoutePermissions(guardFor(ctxFor(['builder_member'])).guard, 'PATCH', STATUS, HEADERS),
    ).resolves.toBeUndefined();
  });

  it('lets a builder_admin record a contract and mark won', async () => {
    const { guard } = guardFor(ctxFor(['builder_admin']));
    await expect(
      enforceRoutePermissions(guard, 'POST', REPORT_CONTRACT, HEADERS),
    ).resolves.toBeUndefined();
    await expect(enforceRoutePermissions(guard, 'POST', MARK_WON, HEADERS)).resolves.toBeUndefined();
  });

  it('401s mark-won with no session', async () => {
    const err = await enforceRoutePermissions(guardFor(null).guard, 'POST', MARK_WON, HEADERS).catch(
      (e: unknown) => e,
    );
    expect((err as HttpError).status).toBe(401);
  });
});
