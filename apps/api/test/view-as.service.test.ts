/**
 * View-as service tests (auth/04).
 *
 * - Activation requires the `view_as` permission (defense in depth: the
 *   route enforces it too, but activation must never depend on one check).
 * - Initiators: staff super_admin/admin and builder-side builder_admin.
 *   viewer and builder_member can never initiate (403 + audit).
 * - Targets: ADMIN TARGETS ARE REJECTED — staff super_admin/admin or any
 *   builder_admin membership is a 403 + `authz.denied` audit. Regular
 *   users (no staff role, no builder_admin membership) may be viewed-as.
 * - Targets must exist: unknown builder/user → 404, never a silent widen.
 * - Disabled users cannot be viewed-as.
 * - Activation requires an active ADMIN session: a token that isn't one
 *   (e.g. a builder-portal token) is 401, never a lying `{active: true}`.
 * - Every activation, denial, and exit is audit-logged under the REAL admin.
 * - switch-builder 403s unless the builder is one of the caller's
 *   memberships — a forged id is never honored.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createViewAsService,
  type ViewAsServiceDeps,
} from '../src/services/view-as.service';
import {
  hashSessionToken,
  type AdminSessionRecord,
} from '../src/services/admin-auth.service';
import { HttpError } from '../src/middleware/errors';
import type { AuthContext } from '../src/services/auth-context.service';
import { effectivePermissions } from '../src/auth/permissions';

const NOW = new Date('2026-09-28T12:00:00Z');
const TOKEN = 'raw-admin-token';
const HASH = hashSessionToken(TOKEN);

function adminCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-admin',
    email: 'admin@example.com',
    name: 'Admin User',
    staffRole: 'admin',
    permissions: effectivePermissions('admin', []),
    builderId: null,
    builderName: null,
    memberships: [],
    viewAs: null,
    realUser: null,
    ...overrides,
  };
}

function builderAdminCtx(
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    userId: 'user-builder-admin-actor',
    email: 'builderadmin@example.com',
    name: 'Builder Admin',
    staffRole: null,
    permissions: effectivePermissions(null, ['builder_admin']),
    builderId: 'builder-1',
    builderName: 'Elite Craft',
    memberships: [
      { builderId: 'builder-1', role: 'builder_admin' as const, createdAt: NOW },
    ],
    viewAs: null,
    realUser: null,
    ...overrides,
  };
}

function sessionRecord(
  overrides: Partial<AdminSessionRecord> = {},
): AdminSessionRecord {
  return {
    id: 'sess-1',
    email: 'admin@example.com',
    sessionTokenHash: HASH,
    idToken: null,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 3600 * 1000),
    createdAt: NOW,
    userId: 'user-admin',
    activeBuilderId: null,
    viewAs: null,
    ...overrides,
  };
}

interface Fixture {
  service: ReturnType<typeof createViewAsService>;
  audit: { log: ReturnType<typeof vi.fn> };
  states: Map<string, AdminSessionRecord>;
}

function makeService(): Fixture {
  const states = new Map<string, AdminSessionRecord>();
  states.set(HASH, sessionRecord());
  const audit = { log: vi.fn(async () => {}) };
  const deps = {
    sessions: {
      findActiveByHash: async (hash: string) =>
        hash === HASH ? sessionRecord() : null,
      updateState: async (
        hash: string,
        patch: {
          readonly activeBuilderId?: string | null;
          readonly viewAs?: { builderId?: string; userId?: string } | null;
        },
      ) => {
        const cur = states.get(hash);
        if (!cur) return;
        states.set(hash, {
          ...cur,
          activeBuilderId:
            'activeBuilderId' in patch
              ? (patch.activeBuilderId ?? null)
              : cur.activeBuilderId,
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
          case 'user-target':
          case 'user-member':
            return base;
          case 'user-disabled':
            return { ...base, status: 'disabled' as const };
          case 'user-superadmin':
            return { ...base, staffRole: 'super_admin' as const };
          case 'user-admin-target':
            return { ...base, staffRole: 'admin' as const };
          case 'user-builder-admin':
            return base;
          default:
            return null;
        }
      },
    },
    memberships: {
      listByUserId: async (userId: string) => {
        switch (userId) {
          case 'user-admin':
            return [{ builderId: 'builder-1', role: 'builder_admin' as const }];
          case 'user-builder-admin':
            return [{ builderId: 'builder-9', role: 'builder_admin' as const }];
          case 'user-member':
            return [{ builderId: 'builder-9', role: 'builder_member' as const }];
          default:
            return [];
        }
      },
    },
    builders: {
      getBuilder: async (id: string) => {
        if (id !== 'builder-1') {
          throw new HttpError(404, 'NOT_FOUND', 'Builder not found.', false);
        }
        return { id: 'builder-1', displayName: 'Elite Craft' };
      },
    },
    audit,
  } as unknown as ViewAsServiceDeps;
  return { service: createViewAsService(deps), audit, states };
}

describe('view-as activation (auth/04)', () => {
  it('activates view-as on a builder and audit-logs the real admin', async () => {
    const fx = makeService();
    const out = await fx.service.activate(
      TOKEN,
      { builderId: 'builder-1' },
      adminCtx(),
    );
    expect(out).toEqual({ active: true });
    expect(fx.states.get(HASH)?.viewAs).toEqual({ builderId: 'builder-1' });
    expect(fx.audit.log).toHaveBeenCalledTimes(1);
    const entry = fx.audit.log.mock.calls[0]![0] as {
      actorEmail: string;
      action: string;
    };
    // Audit identity is the REAL admin, never the target.
    expect(entry.actorEmail).toBe('admin@example.com');
    expect(entry.action).toBe('view_as.activated');
  });

  it('activates view-as on a user', async () => {
    const fx = makeService();
    await fx.service.activate(TOKEN, { userId: 'user-target' }, adminCtx());
    expect(fx.states.get(HASH)?.viewAs).toEqual({ userId: 'user-target' });
  });

  it('activates view-as on a regular builder_member target', async () => {
    const fx = makeService();
    await fx.service.activate(TOKEN, { userId: 'user-member' }, adminCtx());
    expect(fx.states.get(HASH)?.viewAs).toEqual({ userId: 'user-member' });
  });

  it.each(['user-superadmin', 'user-admin-target', 'user-builder-admin'])(
    'rejects admin target %s with 403 + audit (never escalates)',
    async (targetId) => {
      const fx = makeService();
      const err = await fx.service
        .activate(TOKEN, { userId: targetId }, adminCtx())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
      expect(fx.states.get(HASH)?.viewAs).toBeNull();
      expect(fx.audit.log).toHaveBeenCalledTimes(1);
      const entry = fx.audit.log.mock.calls[0]![0] as {
        action: string;
        detail: string;
      };
      expect(entry.action).toBe('authz.denied');
      expect(entry.detail).toContain('reason=admin-target');
    },
  );

  it('builder-side admin can initiate view-as on a regular user', async () => {
    const fx = makeService();
    const out = await fx.service.activate(
      TOKEN,
      { userId: 'user-member' },
      builderAdminCtx(),
    );
    expect(out).toEqual({ active: true });
    expect(fx.states.get(HASH)?.viewAs).toEqual({ userId: 'user-member' });
    const entry = fx.audit.log.mock.calls[0]![0] as { actorEmail: string };
    expect(entry.actorEmail).toBe('builderadmin@example.com');
  });

  it('builder-side admin cannot view-as an admin target either', async () => {
    const fx = makeService();
    const err = await fx.service
      .activate(TOKEN, { userId: 'user-superadmin' }, builderAdminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
  });

  it('builder_member cannot initiate view-as (403, no view_as permission)', async () => {
    const fx = makeService();
    const member = adminCtx({
      staffRole: null,
      permissions: effectivePermissions(null, ['builder_member']),
    });
    const err = await fx.service
      .activate(TOKEN, { userId: 'user-target' }, member)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
  });

  it('token that is not an active admin session is 401, never a lying success', async () => {
    const fx = makeService();
    const err = await fx.service
      .activate('builder-portal-token', { userId: 'user-target' }, adminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
    // No false activation was audit-logged.
    expect(fx.audit.log.mock.calls).toHaveLength(0);
  });

  it('refuses activation without the view_as permission (no escalation)', async () => {
    const fx = makeService();
    const viewer = adminCtx({
      staffRole: 'viewer',
      permissions: effectivePermissions('viewer', []),
    });
    const err = await fx.service
      .activate(TOKEN, { builderId: 'builder-1' }, viewer)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
    // The attempt itself is audit-logged.
    expect(fx.audit.log).toHaveBeenCalledTimes(1);
    const entry = fx.audit.log.mock.calls[0]![0] as { action: string };
    expect(entry.action).toBe('authz.denied');
  });

  it('unknown builder target is 404, never a silent widen', async () => {
    const fx = makeService();
    const err = await fx.service
      .activate(TOKEN, { builderId: 'builder-gone' }, adminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
  });

  it('unknown user target is 404', async () => {
    const fx = makeService();
    const err = await fx.service
      .activate(TOKEN, { userId: 'user-gone' }, adminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
  });

  it('disabled user target cannot be viewed-as', async () => {
    const fx = makeService();
    const err = await fx.service
      .activate(TOKEN, { userId: 'user-disabled' }, adminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
  });

  it('requires a session token (401)', async () => {
    const fx = makeService();
    const err = await fx.service
      .activate(null, { builderId: 'builder-1' }, adminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });
});

describe('view-as exit (auth/04)', () => {
  it('clears view-as and audit-logs under the real admin', async () => {
    const fx = makeService();
    await fx.service.activate(
      TOKEN,
      { builderId: 'builder-1' },
      adminCtx(),
    );
    const out = await fx.service.exit(TOKEN, adminCtx());
    expect(out).toEqual({ active: false });
    expect(fx.states.get(HASH)?.viewAs).toBeNull();
    const actions = fx.audit.log.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toEqual(['view_as.activated', 'view_as.exited']);
    const exitEntry = fx.audit.log.mock.calls[1]![0] as {
      actorEmail: string;
    };
    expect(exitEntry.actorEmail).toBe('admin@example.com');
  });

  it('exiting while already viewing-as another admin keeps the real identity', async () => {
    const fx = makeService();
    const viewingAs = adminCtx({
      viewAs: { builderId: 'builder-1' },
      realUser: {
        userId: 'user-admin',
        email: 'admin@example.com',
        name: 'Admin User',
      },
    });
    await fx.service.exit(TOKEN, viewingAs);
    const entry = fx.audit.log.mock.calls[0]![0] as {
      actorEmail: string;
      action: string;
    };
    expect(entry.actorEmail).toBe('admin@example.com');
    expect(entry.action).toBe('view_as.exited');
  });
});

describe('switch-builder (auth/04)', () => {
  it('switches to a builder in the caller\u2019s memberships', async () => {
    const fx = makeService();
    const out = await fx.service.switchBuilder(TOKEN, 'builder-1', adminCtx());
    expect(out).toEqual({ builderId: 'builder-1' });
    expect(fx.states.get(HASH)?.activeBuilderId).toBe('builder-1');
  });

  it('403 + audit for a builder outside the memberships (forged id never honored)', async () => {
    const fx = makeService();
    const err = await fx.service
      .switchBuilder(TOKEN, 'builder-evil', adminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(fx.states.get(HASH)?.activeBuilderId).toBeNull();
    expect(fx.audit.log).toHaveBeenCalledTimes(1);
    const entry = fx.audit.log.mock.calls[0]![0] as { action: string };
    expect(entry.action).toBe('authz.denied');
  });

  it('requires a session token (401)', async () => {
    const fx = makeService();
    const err = await fx.service
      .switchBuilder(null, 'builder-1', adminCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });
});
