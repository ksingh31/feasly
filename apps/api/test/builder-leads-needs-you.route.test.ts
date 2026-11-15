/**
 * Route tests for GET /api/v1/builder/leads/needs-you (issue #526).
 *
 * The route is a thin adapter: builder session → service.getNeedsYou with
 * the SESSION's tenant key. Services are stubbed. Authorization:
 * - 401 when there is no builder session (route) or no auth context
 *   (central registry permission check);
 * - 403 for a role without `builder:leads:read` (viewer);
 * - builder_admin / builder_member pass.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BuilderLeadsNeedsYouResponse } from '@feasly/contracts';
import { createBuilderLeadsRoute } from '../src/routes/builder-leads.route';
import type { BuilderLeadsService } from '../src/services/builder-leads.service';
import type { BuilderGuard } from '../src/middleware/builder-guard';
import type { BuilderSession } from '../src/services/builder-auth.service';
import { HttpError } from '../src/middleware/errors';
import { enforceRoutePermissions } from '../src/middleware/enforce-route-permissions';
import {
  createPermissionGuard,
  type PermissionGuardDeps,
} from '../src/middleware/permission-guard';
import type { AuthContext } from '../src/services/auth-context.service';
import { effectivePermissions } from '../src/auth/permissions';
import { resolveToRegistry } from '../src/registry/route-registry';

const PATH = '/api/v1/builder/leads/needs-you';
const HEADERS = { cookie: 'feasly_builder=<redacted>' };

const FEED: BuilderLeadsNeedsYouResponse = {
  uncontacted: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Jane Doe',
      email: 'homeowner@example.com',
      phone: null,
      timeline: '0-3 months',
      leadScore: 90,
      status: 'new',
      addressKey: '3415 19 ST SW',
      createdAt: '2026-11-15T10:00:00.000Z',
      statusChangedAt: '2026-11-15T10:00:00.000Z',
      waitingSince: '2026-11-15T10:00:00.000Z',
    },
  ],
  stale: [],
  wonWithoutContract: [],
  staleAfterDays: 7,
  counts: { total: 1, new: 1, contacted: 0, quoted: 0, won: 0, lost: 0 },
};

function makeRoute(session: { email: string; tenantKey: string } | null) {
  const builderSession: BuilderSession | null =
    session === null ? null : { ...session, builderId: 'builder-elite', viewAs: null };
  const getNeedsYou = vi.fn(async (_tenantKey: string) => FEED);
  const builderLeads = {
    listLeads: vi.fn(),
    getNeedsYou,
    updateStatus: vi.fn(),
  } as unknown as BuilderLeadsService;
  const builderGuard: BuilderGuard = {
    requireBuilder: async () => {},
    getBuilderSession: async () => builderSession,
  };
  return { route: createBuilderLeadsRoute({
      builderLeads,
      builderGuard,
      permissionGuard: { requirePermission: async () => ctxFor('builder_admin') },
    }), getNeedsYou };
}

function ctxFor(role: 'builder_admin' | 'builder_member' | 'viewer'): AuthContext {
  const isBuilder = role !== 'viewer';
  return {
    userId: 'user-1',
    email: 'someone@example.com',
    name: 'Someone',
    staffRole: isBuilder ? null : role,
    permissions: isBuilder
      ? effectivePermissions(null, [role])
      : effectivePermissions(role, []),
    builderId: isBuilder ? 'builder-elite' : null,
    builderName: isBuilder ? 'Elite Craft Builders' : null,
    memberships: [],
    viewAs: null,
    realUser: null,
  } as AuthContext;
}

function guardResolving(ctx: AuthContext | null) {
  return createPermissionGuard({
    authContext: {
      resolve: async () => ctx,
      auditDenied: vi.fn(async () => {}),
      auditViewAsAction: vi.fn(async () => {}),
    } as unknown as PermissionGuardDeps['authContext'],
  });
}

describe('GET /api/v1/builder/leads/needs-you route (issue #526)', () => {
  it('is a registered route', () => {
    expect(resolveToRegistry('GET', PATH)).toBe(`GET ${PATH}`);
  });

  it('returns the service feed for the session tenant', async () => {
    const { route, getNeedsYou } = makeRoute({
      email: 'build@elitecraftbuilders.com',
      tenantKey: 'elite-craft',
    });

    const result = await route.needsYou(HEADERS);

    expect(result).toEqual(FEED);
    expect(getNeedsYou).toHaveBeenCalledTimes(1);
    expect(getNeedsYou).toHaveBeenCalledWith('elite-craft');
  });

  it('ignores any client-supplied tenant header (session is the only scope)', async () => {
    const { route, getNeedsYou } = makeRoute({
      email: 'build@elitecraftbuilders.com',
      tenantKey: 'elite-craft',
    });

    await route.needsYou({ ...HEADERS, 'x-tenant-key': 'other' });

    expect(getNeedsYou).toHaveBeenCalledWith('elite-craft');
  });

  it('returns 401 without a builder session and never calls the service', async () => {
    const { route, getNeedsYou } = makeRoute(null);

    const err = await route.needsYou({}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect(getNeedsYou).not.toHaveBeenCalled();
  });

  it('registry permission check: 401 when unauthenticated', async () => {
    const err = await enforceRoutePermissions(guardResolving(null), 'GET', PATH, {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });

  it('registry permission check: 403 for a role without builder:leads:read', async () => {
    const err = await enforceRoutePermissions(
      guardResolving(ctxFor('viewer')),
      'GET',
      PATH,
      HEADERS,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
  });

  it.each(['builder_admin', 'builder_member'] as const)(
    'registry permission check: %s is allowed',
    async (role) => {
      await expect(
        enforceRoutePermissions(guardResolving(ctxFor(role)), 'GET', PATH, HEADERS),
      ).resolves.toBeUndefined();
    },
  );
});
