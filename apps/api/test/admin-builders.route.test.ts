/**
 * Unit tests for the admin-builders route (embed/02 admin-UI migration).
 *
 * Verifies:
 * - All endpoints require admin auth (401 without valid session).
 * - list returns builders from the service.
 * - create validates input and delegates to the service.
 * - get/update validate the id param.
 * - Invalid bodies are rejected with 400.
 *
 * Fakes the BuilderService interface; no DB. Tests run under vitest.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createAdminBuildersRoute,
  type AdminBuildersRouteDeps,
} from '../src/routes/admin-builders.route';
import { createAdminLeadsRoute } from '../src/routes/admin-leads.route';
import type { BuilderLifecycleService } from '../src/services/builder-lifecycle.service';
import type { BuilderService } from '../src/services/builder.service';
import type { AdminGuard } from '../src/middleware/admin-guard';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const VALID_SESSION = 'feasly_admin_session=valid-test-session';

const BUILDER_ID = '123e4567-e89b-12d3-a456-426614174000';
const LEAD_ID = '123e4567-e89b-12d3-a456-426614174001';

function makeBuilder(overrides?: Partial<Record<string, unknown>>) {
  const now = new Date().toISOString();
  return {
    id: BUILDER_ID,
    tenantKey: 'elite-craft',
    businessName: 'Elite Craft Builders Ltd.',
    displayName: 'Elite Craft Builders',
    email: 'build@elitecraftbuilders.com',
    phone: null,
    logoUrl: null,
    accentColor: '#C9A227',
    allowedOrigins: [],
    plan: null,
    status: 'active',
    settings: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDeps() {
  const builders = {
    listBuilders: vi.fn(async () => [makeBuilder()]),
    getBuilder: vi.fn(async (id: string) => {
      if (id === 'missing') {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.', false);
      }
      return makeBuilder({ id });
    }),
    getByTenantKey: vi.fn(async () => null),
    createBuilder: vi.fn(async (input: unknown) => makeBuilder(input as Record<string, unknown>)),
    updateBuilder: vi.fn(async (id: string, input: unknown) =>
      makeBuilder({ id, ...(input as Record<string, unknown>) }),
    ),
    assignLead: vi.fn(async () => ({ ok: true as const })),
  } as unknown as BuilderService;

  const adminGuard = {
    async requireAdmin(headers: Record<string, string | string[] | undefined>) {
      const cookie = headers['cookie'];
      const value = Array.isArray(cookie) ? cookie[0] : cookie;
      if (value !== VALID_SESSION) {
        throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.', false);
      }
    },
    async getAdminEmail() {
      return 'admin@example.com';
    },
  } as unknown as AdminGuard;

  const lifecycle = {
    changeStatus: vi.fn(async (id: string, action: string, reason: string) => ({
      builder: makeBuilder({ id, status: action === 'suspend' ? 'suspended' : 'active', statusReason: reason }),
      changed: true,
    })),
    offboardingBlockers: vi.fn(async () => []),
    exportCsv: vi.fn(async (_id: string, kind: string) => ({
      csv: 'lead_id\n',
      filename: `elite-craft-${kind}-2026-11-16.csv`,
    })),
  } as unknown as BuilderLifecycleService;

  const route = createAdminBuildersRoute({ builders, adminGuard, lifecycle });
  const headers = { cookie: VALID_SESSION };
  return { route, builders, headers, lifecycle };
}

describe('admin-builders route', () => {
  it('list returns builders from the service', async () => {
    const { route, headers } = makeDeps();
    const result = await route.list(headers);
    expect(result.builders).toHaveLength(1);
    expect(result.builders[0]?.tenantKey).toBe('elite-craft');
  });

  it('list requires admin auth', async () => {
    const { route } = makeDeps();
    await expect(route.list({})).rejects.toMatchObject({ status: 401 });
  });

  it('create delegates to the service with validated input', async () => {
    const { route, builders, headers } = makeDeps();
    const result = await route.create(headers, {
      tenantKey: 'new-builder',
      businessName: 'New Builder Inc.',
      displayName: 'New Builder',
      email: 'hello@newbuilder.com',
      status: 'active',
    });
    expect(builders.createBuilder).toHaveBeenCalledTimes(1);
    const [input, adminEmail] = (builders.createBuilder as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string];
    expect(input.tenantKey).toBe('new-builder');
    expect(adminEmail).toBe('admin@example.com');
    expect(result.tenantKey).toBe('new-builder');
  });

  it('create rejects invalid tenant key with 400', async () => {
    const { route, headers } = makeDeps();
    await expect(
      route.create(headers, {
        tenantKey: 'INVALID KEY!',
        businessName: 'Bad',
        displayName: 'Bad',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('create rejects invalid accent color with 400', async () => {
    const { route, headers } = makeDeps();
    await expect(
      route.create(headers, {
        tenantKey: 'new-builder',
        businessName: 'New',
        displayName: 'New',
        accentColor: 'not-a-color',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('create requires admin auth', async () => {
    const { route } = makeDeps();
    await expect(
      route.create({}, { tenantKey: 'x', businessName: 'y', displayName: 'z' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('get returns the builder', async () => {
    const { route, headers } = makeDeps();
    const result = await route.get(headers, BUILDER_ID);
    expect(result.id).toBe(BUILDER_ID);
  });

  it('get rejects invalid uuid with 400', async () => {
    const { route, headers } = makeDeps();
    await expect(route.get(headers, 'not-a-uuid')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('update delegates to the service', async () => {
    const { route, builders, headers } = makeDeps();
    const result = await route.update(headers, BUILDER_ID, {
      displayName: 'Updated Name',
      status: 'active',
    });
    expect(builders.updateBuilder).toHaveBeenCalledTimes(1);
    expect(result.displayName).toBe('Updated Name');
  });

  it('update requires admin auth', async () => {
    const { route } = makeDeps();
    await expect(
      route.update({}, BUILDER_ID, { displayName: 'X' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('admin-builders lifecycle routes (#860)', () => {
  it('changeStatus passes action, reason and the admin identity to the service', async () => {
    const { route, headers, lifecycle } = makeDeps();
    const result = await route.changeStatus(headers, BUILDER_ID, {
      action: 'suspend',
      reason: 'Unpaid invoices',
    });
    expect(lifecycle.changeStatus).toHaveBeenCalledWith(
      BUILDER_ID,
      'suspend',
      'Unpaid invoices',
      'admin@example.com',
    );
    expect(result.builder.status).toBe('suspended');
  });

  it.each([
    [{ action: 'suspend' }],
    [{ action: 'suspend', reason: '  ' }],
    [{ action: 'delete', reason: 'nope nope' }],
    [{ action: 'suspend', reason: 'x'.repeat(1001) }],
  ])('changeStatus rejects a missing reason or unknown action (%j)', async (body) => {
    const { route, headers, lifecycle } = makeDeps();
    await expect(route.changeStatus(headers, BUILDER_ID, body)).rejects.toMatchObject({
      status: 400,
    });
    expect(lifecycle.changeStatus).not.toHaveBeenCalled();
  });

  it('changeStatus requires admin auth (401)', async () => {
    const { route } = makeDeps();
    await expect(
      route.changeStatus({}, BUILDER_ID, { action: 'suspend', reason: 'Because' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('exportCsv validates kind and returns the csv', async () => {
    const { route, headers, lifecycle } = makeDeps();
    const out = await route.exportCsv(headers, BUILDER_ID, { kind: 'invoices' });
    expect(out.filename).toBe('elite-craft-invoices-2026-11-16.csv');
    expect(lifecycle.exportCsv).toHaveBeenCalledWith(BUILDER_ID, 'invoices', 'admin@example.com');
    await expect(route.exportCsv(headers, BUILDER_ID, { kind: 'users' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(route.exportCsv({}, BUILDER_ID, { kind: 'leads' })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('admin-leads assign-builder route', () => {
  function makeAssignDeps() {
    const builders = {
      assignLead: vi.fn(async () => ({ ok: true as const })),
    };
    const adminGuard = {
      async requireAdmin(headers: Record<string, string | string[] | undefined>) {
        const cookie = headers['cookie'];
        const value = Array.isArray(cookie) ? cookie[0] : cookie;
        if (value !== VALID_SESSION) {
          throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.', false);
        }
      },
      async getAdminEmail() {
        return 'admin@example.com';
      },
    };
    // We test via the admin-leads route's assignBuilder method.
    // Import lazily to avoid circular deps in the test.
    return { builders, adminGuard };
  }

  it('assignBuilder validates builderId as uuid or null', async () => {
    const { builders, adminGuard } = makeAssignDeps();
    // createAdminLeadsRoute is imported statically at the top of this file.
    const route = createAdminLeadsRoute({
      adminLeads: {} as never,
      builders: builders as unknown as BuilderService,
      adminGuard: adminGuard as unknown as AdminGuard,
    });
    const headers = { cookie: VALID_SESSION };

    // Valid uuid.
    await route.assignBuilder(headers, LEAD_ID, {
      builderId: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(builders.assignLead).toHaveBeenCalledWith(
      LEAD_ID,
      '123e4567-e89b-12d3-a456-426614174000',
      'admin@example.com',
    );

    // Null unassigns.
    await route.assignBuilder(headers, LEAD_ID, { builderId: null });
    expect(builders.assignLead).toHaveBeenCalledWith(LEAD_ID, null, 'admin@example.com');

    // Invalid uuid rejected.
    await expect(
      route.assignBuilder(headers, LEAD_ID, { builderId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('assignBuilder returns the service result and propagates 409 LEAD_HAS_INVOICE (#721)', async () => {
    const { builders, adminGuard } = makeAssignDeps();
    const response = {
      ok: true as const,
      changed: true,
      fromBuilderId: '123e4567-e89b-12d3-a456-426614174001',
      toBuilderId: '123e4567-e89b-12d3-a456-426614174000',
    };
    builders.assignLead.mockResolvedValueOnce(response as never);
    builders.assignLead.mockRejectedValueOnce(
      new HttpError(
        409,
        ErrorCodes.LEAD_HAS_INVOICE,
        'This lead has unpaid invoice INV-0042 (in_review) with its current builder.',
        false,
      ),
    );
    const route = createAdminLeadsRoute({
      adminLeads: {} as never,
      builders: builders as unknown as BuilderService,
      adminGuard: adminGuard as unknown as AdminGuard,
    });
    const headers = { cookie: VALID_SESSION };
    await expect(
      route.assignBuilder(headers, LEAD_ID, { builderId: response.toBuilderId }),
    ).resolves.toEqual(response);
    await expect(
      route.assignBuilder(headers, LEAD_ID, { builderId: null }),
    ).rejects.toMatchObject({ status: 409, code: ErrorCodes.LEAD_HAS_INVOICE });
  });

  it('assignBuilder requires admin auth', async () => {
    const { builders, adminGuard } = makeAssignDeps();
    // createAdminLeadsRoute is imported statically at the top of this file.
    const route = createAdminLeadsRoute({
      adminLeads: {} as never,
      builders: builders as unknown as BuilderService,
      adminGuard: adminGuard as unknown as AdminGuard,
    });
    await expect(
      route.assignBuilder({}, LEAD_ID, { builderId: null }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
