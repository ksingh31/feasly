/**
 * #731 AC5 — every action taken under view-as is attributable to the REAL
 * actor in the audit log.
 *
 * End to end through the real pieces: AuthContextService (session →
 * borrowed view + `realUser`) → PermissionGuard → `enforceRoutePermissions`
 * (the central point every Function adapter runs). Only the stores are
 * faked. Activation/exit attribution is pinned in view-as.service.test.ts
 * and builder-view-as.service.test.ts ("audit-logs the real admin",
 * "audits under the real identity").
 *
 * Regression: routes gated ONLY by `permissionsAnyOf` (admin user
 * management) used to skip the view-as action audit.
 */
import { describe, expect, it, vi } from 'vitest';
import { enforceRoutePermissions } from '../src/middleware/enforce-route-permissions';
import { createPermissionGuard } from '../src/middleware/permission-guard';
import {
  createAuthContextService,
  type AuthContextServiceDeps,
} from '../src/services/auth-context.service';
import {
  hashSessionToken,
  type AdminSessionRecord,
} from '../src/services/admin-auth.service';
import type { BuilderSession } from '../src/services/builder-auth.service';
import type { BuilderMembership, UserRecord } from '../src/services/user.service';
import { ROUTE_REGISTRY } from '../src/registry/route-registry';

const NOW = new Date('2026-11-15T12:00:00Z');
const ADMIN_TOKEN = 'admin-token';
const BUILDER_TOKEN = 'builder-token';

function user(overrides: Partial<UserRecord>): UserRecord {
  return {
    id: 'user-x',
    email: 'x@example.com',
    name: 'X',
    status: 'active',
    staffRole: null,
    entraObjectId: null,
    isProtected: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface AuditRow {
  readonly actorEmail: string | null;
  readonly action: string;
  readonly detail: string;
}

function harness(opts: {
  adminViewAs?: AdminSessionRecord['viewAs'];
  builderViewAs?: BuilderSession['viewAs'];
}) {
  const users = [
    user({ id: 'user-admin', email: 'admin@example.com', name: 'Real Admin', staffRole: 'admin' }),
    user({ id: 'user-owner', email: 'owner@builder-a.example', name: 'Real Owner' }),
    user({ id: 'user-member', email: 'member@builder-a.example', name: 'Target Member' }),
  ];
  const memberships: Record<string, BuilderMembership[]> = {
    'user-owner': [{ builderId: 'builder-a', role: 'builder_admin', createdAt: NOW }],
    'user-member': [{ builderId: 'builder-a', role: 'builder_member', createdAt: NOW }],
  };
  const adminSession: AdminSessionRecord = {
    id: 'sess-admin',
    email: 'admin@example.com',
    sessionTokenHash: hashSessionToken(ADMIN_TOKEN),
    idToken: null,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + 3600_000),
    createdAt: NOW,
    userId: 'user-admin',
    activeBuilderId: null,
    viewAs: opts.adminViewAs ?? null,
  };
  const builderSession: BuilderSession = {
    email: 'owner@builder-a.example',
    tenantKey: 'tenant-a',
    builderId: 'builder-a',
    viewAs: opts.builderViewAs ?? null,
  };
  const rows: AuditRow[] = [];
  const deps = {
    adminSessions: {
      findActiveByHash: async (hash: string) =>
        hash === adminSession.sessionTokenHash ? adminSession : null,
    },
    builderAuth: {
      validateSession: async (token: string | null) =>
        token === BUILDER_TOKEN ? builderSession : null,
    },
    users: {
      findByEmail: async (email: string) =>
        users.find((u) => u.email === email.toLowerCase()) ?? null,
      findById: async (id: string) => users.find((u) => u.id === id) ?? null,
    },
    memberships: {
      listByUserId: async (id: string) => memberships[id] ?? [],
    },
    builders: {
      getBuilder: async (id: string) => {
        if (id !== 'builder-a') throw new Error('not found');
        return { id, displayName: 'Builder A', status: 'active' };
      },
      getByTenantKey: async () => null,
    },
    audit: { log: vi.fn(async (row: AuditRow) => void rows.push(row)) },
    clock: () => NOW,
  } as unknown as AuthContextServiceDeps;
  const authContext = createAuthContextService(deps);
  const guard = createPermissionGuard({ authContext });
  return { guard, rows };
}

const ADMIN_HEADERS = { authorization: `Bearer ${ADMIN_TOKEN}` };
const BUILDER_HEADERS = { cookie: `feasly_builder_session=${BUILDER_TOKEN}` };

function route(method: string, path: string) {
  const entry = ROUTE_REGISTRY.find((e) => e.method === method && e.path === path);
  if (!entry) throw new Error(`not in registry: ${method} ${path}`);
  return entry;
}

describe('view-as audit attribution (#731 AC5)', () => {
  it('admin viewing-as a builder: a protected action is logged under the real admin', async () => {
    const { guard, rows } = harness({ adminViewAs: { builderId: 'builder-a' } });
    const r = route('PATCH', '/api/v1/builder/leads/{id}');
    expect(r.permissions.length).toBeGreaterThan(0);
    await enforceRoutePermissions(guard, r.method, r.path, ADMIN_HEADERS);
    expect(rows).toEqual([
      {
        actorEmail: 'admin@example.com',
        action: 'authz.view_as_action',
        detail: `route=PATCH ${r.path} view_as=1`,
      },
    ]);
  });

  it('anyOf-only routes (admin user management) are audited under view-as too — regression', async () => {
    const { guard, rows } = harness({ adminViewAs: { builderId: 'builder-a' } });
    const r = route('PATCH', '/api/v1/admin/users/{id}');
    expect(r.permissions).toEqual([]);
    expect(r.permissionsAnyOf?.length).toBeGreaterThan(0);
    await enforceRoutePermissions(guard, r.method, r.path, ADMIN_HEADERS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: 'admin@example.com',
      action: 'authz.view_as_action',
    });
  });

  it('builder admin viewing-as a team member: actions are logged under the real owner, never the target', async () => {
    const { guard, rows } = harness({ builderViewAs: { userId: 'user-member' } });
    const r = route('GET', '/api/v1/builder/leads/{id}');
    await enforceRoutePermissions(guard, r.method, r.path, BUILDER_HEADERS);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actorEmail).toBe('owner@builder-a.example');
      expect(row.actorEmail).not.toBe('member@builder-a.example');
    }
    expect(rows.map((row) => row.action)).toContain('authz.view_as_action');
  });

  it('a denied action under view-as is logged under the real actor, with the view-as flag', async () => {
    const { guard, rows } = harness({ builderViewAs: { userId: 'user-member' } });
    // The borrowed member view lacks builder user management.
    const r = route('PATCH', '/api/v1/builder/users/{id}');
    await expect(
      enforceRoutePermissions(guard, r.method, r.path, BUILDER_HEADERS),
    ).rejects.toMatchObject({ status: 403 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: 'owner@builder-a.example',
      action: 'authz.denied',
    });
    expect(rows[0]!.detail).toContain('view_as=1');
  });

  it('no view-as: ordinary actions write no view-as audit rows', async () => {
    const { guard, rows } = harness({});
    const r = route('GET', '/api/v1/builder/leads/{id}');
    await enforceRoutePermissions(guard, r.method, r.path, BUILDER_HEADERS);
    expect(rows).toEqual([]);
  });
});
