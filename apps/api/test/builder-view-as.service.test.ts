/**
 * Builder-side view-as service tests (2026-09-30, Karan).
 *
 * - Activation requires the `view_as` permission (defense in depth: the
 *   route enforces it too). A `builder_member` can never initiate
 *   (403 + `authz.denied` audit).
 * - Targets are userId-only and ORG-SCOPED: the target must hold a
 *   membership in the actor's own org. Cross-org targets are 403 +
 *   `authz.denied`, never honored.
 * - #394 lockdown unchanged: a staff super_admin/admin, or anyone
 *   holding a builder_admin membership (ANY org — including the actor's
 *   own), can never be viewed-as (403 + `authz.denied` audit).
 * - Targets must exist and be active: unknown/disabled → 404.
 * - Activation requires an ACTIVE BUILDER session: a token that isn't
 *   one (e.g. an admin-portal token presented to this endpoint) is 401,
 *   never a lying `{active: true}`.
 * - Exit is session-only: a viewed-as session (borrowed view has no
 *   `view_as` permission) can exit; exiting clears the state and the
 *   session's own permissions resolve again on the next request.
 * - Every activation, denial, and exit is audit-logged under the REAL
 *   builder admin's identity (never the target's).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBuilderViewAsService,
  type BuilderViewAsServiceDeps,
} from '../src/services/builder-view-as.service';
import {
  hashBuilderSessionToken,
  type BuilderSessionRecord,
} from '../src/services/builder-auth.service';
import { HttpError } from '../src/middleware/errors';
import type { AuthContext } from '../src/services/auth-context.service';
import { effectivePermissions } from '../src/auth/permissions';

const NOW = new Date('2026-09-28T12:00:00Z');
const TOKEN = 'raw-builder-token';
const HASH = hashBuilderSessionToken(TOKEN);

function builderAdminCtx(
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    userId: 'user-builder-admin',
    email: 'builderadmin@example.com',
    name: 'Builder Admin',
    staffRole: null,
    permissions: effectivePermissions(null, ['builder_admin']),
    builderId: 'builder-1',
    builderName: 'Elite Craft',
    memberships: [
      {
        builderId: 'builder-1',
        role: 'builder_admin' as const,
        createdAt: NOW,
      },
    ],
    viewAs: null,
    realUser: null,
    ...overrides,
  };
}

function sessionRecord(
  overrides: Partial<BuilderSessionRecord> = {},
): BuilderSessionRecord {
  return {
    id: 'sess-1',
    email: 'builderadmin@example.com',
    tenantKey: 'elite-craft',
    builderId: 'builder-1',
    userId: 'user-builder-admin',
    viewAs: null,
    sessionTokenHash: HASH,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 3600 * 1000),
    createdAt: NOW,
    ...overrides,
  };
}

interface Fixture {
  service: ReturnType<typeof createBuilderViewAsService>;
  audit: { log: ReturnType<typeof vi.fn> };
  states: Map<string, BuilderSessionRecord>;
}

function makeService(): Fixture {
  const states = new Map<string, BuilderSessionRecord>();
  states.set(HASH, sessionRecord());
  const audit = { log: vi.fn(async () => {}) };
  const deps = {
    sessions: {
      findActiveByHash: async (hash: string) =>
        hash === HASH ? states.get(hash) ?? null : null,
      updateState: async (
        hash: string,
        patch: { readonly viewAs?: { readonly userId?: string } | null },
      ) => {
        const cur = states.get(hash);
        if (!cur) return;
        states.set(hash, {
          ...cur,
          viewAs: 'viewAs' in patch ? (patch.viewAs ?? null) : cur.viewAs,
        });
      },
    },
    users: {
      findById: async (id: string) => {
        const base = {
          id,
          email: `${id}@example.com`,
          name: id,
          status: 'active' as const,
          staffRole: null as 'super_admin' | 'admin' | null,
        };
        switch (id) {
          case 'user-member':
          case 'user-cross-org':
          case 'user-no-membership':
            return base;
          case 'user-disabled':
            return { ...base, status: 'disabled' as const };
          case 'user-superadmin':
            return { ...base, staffRole: 'super_admin' as const };
          case 'user-admin-target':
            return { ...base, staffRole: 'admin' as const };
          case 'user-builder-admin-target':
            return base;
          default:
            return null;
        }
      },
    },
    memberships: {
      listByUserId: async (userId: string) => {
        switch (userId) {
          case 'user-member':
            return [{ builderId: 'builder-1', role: 'builder_member' as const }];
          case 'user-builder-admin-target':
            // A builder_admin in the SAME org — still an admin target.
            return [{ builderId: 'builder-1', role: 'builder_admin' as const }];
          case 'user-cross-org':
            return [{ builderId: 'builder-2', role: 'builder_member' as const }];
          default:
            return [];
        }
      },
    },
    audit,
  } as unknown as BuilderViewAsServiceDeps;
  return { service: createBuilderViewAsService(deps), audit, states };
}

async function expectHttp(
  promise: Promise<unknown>,
  status: number,
): Promise<HttpError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    return e as HttpError;
  }
  throw new Error(`expected HttpError ${status}, but the call succeeded`);
}

describe('builder view-as activate', () => {
  it('activates view-as for a regular team member in the same org', async () => {
    const { service, states, audit } = makeService();
    const res = await service.activate(
      TOKEN,
      'user-member',
      builderAdminCtx(),
    );
    expect(res).toEqual({ active: true });
    expect(states.get(HASH)?.viewAs).toEqual({ userId: 'user-member' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'builderadmin@example.com',
        action: 'view_as.activated',
        detail: 'target=user:user-member',
      }),
    );
  });

  it('403s when the initiator lacks the view_as permission (builder_member)', async () => {
    const { service, states, audit } = makeService();
    const ctx = builderAdminCtx({
      permissions: effectivePermissions(null, ['builder_member']),
    });
    await expectHttp(service.activate(TOKEN, 'user-member', ctx), 403);
    expect(states.get(HASH)?.viewAs).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.denied' }),
    );
  });

  it('403s a cross-org target (403, never silently re-scoped)', async () => {
    const { service, states, audit } = makeService();
    await expectHttp(
      service.activate(TOKEN, 'user-cross-org', builderAdminCtx()),
      403,
    );
    expect(states.get(HASH)?.viewAs).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'authz.denied',
        detail: expect.stringContaining('reason=cross-org'),
      }),
    );
  });

  it('403s a target with no org membership', async () => {
    const { service, audit } = makeService();
    await expectHttp(
      service.activate(TOKEN, 'user-no-membership', builderAdminCtx()),
      403,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'authz.denied',
        detail: expect.stringContaining('reason=cross-org'),
      }),
    );
  });

  it('403s a staff super_admin target', async () => {
    const { service, audit } = makeService();
    await expectHttp(
      service.activate(TOKEN, 'user-superadmin', builderAdminCtx()),
      403,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'authz.denied',
        detail: expect.stringContaining('reason=admin-target'),
      }),
    );
  });

  it('403s a staff admin target', async () => {
    const { service, audit } = makeService();
    await expectHttp(
      service.activate(TOKEN, 'user-admin-target', builderAdminCtx()),
      403,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'authz.denied',
        detail: expect.stringContaining('reason=admin-target'),
      }),
    );
  });

  it('403s a builder_admin target — even in the actor\u2019s own org', async () => {
    const { service, states, audit } = makeService();
    await expectHttp(
      service.activate(TOKEN, 'user-builder-admin-target', builderAdminCtx()),
      403,
    );
    expect(states.get(HASH)?.viewAs).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'authz.denied',
        detail: expect.stringContaining('reason=admin-target'),
      }),
    );
  });

  it('404s an unknown target', async () => {
    const { service } = makeService();
    await expectHttp(
      service.activate(TOKEN, 'user-unknown', builderAdminCtx()),
      404,
    );
  });

  it('404s a disabled target', async () => {
    const { service } = makeService();
    await expectHttp(
      service.activate(TOKEN, 'user-disabled', builderAdminCtx()),
      404,
    );
  });

  it('401s when the token is not an active builder session', async () => {
    const { service, states } = makeService();
    await expectHttp(
      service.activate('not-a-builder-token', 'user-member', builderAdminCtx()),
      401,
    );
    expect(states.get(HASH)?.viewAs).toBeNull();
  });

  it('401s when no token is presented', async () => {
    const { service } = makeService();
    await expectHttp(service.activate(null, 'user-member', builderAdminCtx()), 401);
  });
});

describe('builder view-as exit', () => {
  it('clears view-as state and audits under the real identity', async () => {
    const { service, states, audit } = makeService();
    await service.activate(TOKEN, 'user-member', builderAdminCtx());
    expect(states.get(HASH)?.viewAs).toEqual({ userId: 'user-member' });

    const res = await service.exit(TOKEN, builderAdminCtx());
    expect(res).toEqual({ active: false });
    expect(states.get(HASH)?.viewAs).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'builderadmin@example.com',
        action: 'view_as.exited',
      }),
    );
  });

  it('exit works from the borrowed view (which has no view_as permission) — session-only', async () => {
    const { service, states } = makeService();
    await service.activate(TOKEN, 'user-member', builderAdminCtx());
    // The borrowed view-as context: the target's permissions (no view_as).
    const borrowedCtx = builderAdminCtx({
      userId: 'user-member',
      email: 'user-member@example.com',
      name: 'user-member',
      permissions: effectivePermissions(null, ['builder_member']),
      viewAs: { userId: 'user-member' },
      realUser: {
        userId: 'user-builder-admin',
        email: 'builderadmin@example.com',
        name: 'Builder Admin',
      },
    });
    const res = await service.exit(TOKEN, borrowedCtx);
    expect(res).toEqual({ active: false });
    expect(states.get(HASH)?.viewAs).toBeNull();
  });

  it('401s when the token is not an active builder session', async () => {
    const { service } = makeService();
    await expectHttp(service.exit('not-a-builder-token', builderAdminCtx()), 401);
  });
});
