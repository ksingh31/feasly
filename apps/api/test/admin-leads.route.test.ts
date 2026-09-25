/**
 * Admin leads-explorer route tests (admin/02).
 *
 * The route is thin: admin guard → one service method → response shape.
 * Real business logic lives in the service (covered by
 * admin-leads.service.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminLeadsRoute,
  type AdminLeadsRouteDeps,
} from '../src/routes/admin-leads.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { AdminLeadsService } from '../src/services/admin-leads.service';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };
const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';

function makeDeps(): AdminLeadsRouteDeps {
  const service: AdminLeadsService = {
    listLeads: vi.fn().mockResolvedValue({ leads: [], nextCursor: null, totalCount: 0 }),
    getLead: vi.fn(),
    addNote: vi.fn().mockResolvedValue({ ok: true as const }),
    updateStatus: vi.fn().mockResolvedValue({ ok: true as const }),
    exportCsv: vi.fn().mockResolvedValue({ csv: 'id\n', filename: 'test.csv' }),
  };
  return {
    adminLeads: service,
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

describe('admin-leads route (admin/02)', () => {
  it('list: admin passes → service called with query and email', async () => {
    const deps = makeDeps();
    const route = createAdminLeadsRoute(deps);

    await route.list(ADMIN_HEADERS, { status: 'new' });

    expect(deps.adminLeads.listLeads).toHaveBeenCalledWith(
      { status: 'new' },
      ADMIN_EMAIL,
    );
  });

  it('list: unauthenticated → 401', async () => {
    const deps = makeDeps();
    const route = createAdminLeadsRoute(deps);

    await expect(route.list({}, {})).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(deps.adminLeads.listLeads).not.toHaveBeenCalled();
  });

  it('get: validates UUID param', async () => {
    const deps = makeDeps();
    const route = createAdminLeadsRoute(deps);

    await expect(route.get(ADMIN_HEADERS, 'not-a-uuid')).rejects.toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(deps.adminLeads.getLead).not.toHaveBeenCalled();
  });

  it('get: valid UUID → service called', async () => {
    const deps = makeDeps();
    const route = createAdminLeadsRoute(deps);
    const id = '123e4567-e89b-12d3-a456-426614174000';
    vi.mocked(deps.adminLeads.getLead).mockResolvedValue({ id } as never);

    await route.get(ADMIN_HEADERS, id);

    expect(deps.adminLeads.getLead).toHaveBeenCalledWith(id, ADMIN_EMAIL);
  });

  it('addNote: passes through to service', async () => {
    const deps = makeDeps();
    const route = createAdminLeadsRoute(deps);
    const id = '123e4567-e89b-12d3-a456-426614174000';

    const result = await route.addNote(ADMIN_HEADERS, id, { note: 'test' });

    expect(result.ok).toBe(true);
    expect(deps.adminLeads.addNote).toHaveBeenCalledWith(
      id,
      { note: 'test' },
      ADMIN_EMAIL,
    );
  });

  it('updateStatus: passes through to service', async () => {
    const deps = makeDeps();
    const route = createAdminLeadsRoute(deps);
    const id = '123e4567-e89b-12d3-a456-426614174000';

    const result = await route.updateStatus(ADMIN_HEADERS, id, {
      status: 'contacted',
    });

    expect(result.ok).toBe(true);
    expect(deps.adminLeads.updateStatus).toHaveBeenCalledWith(
      id,
      { status: 'contacted' },
      ADMIN_EMAIL,
    );
  });

  it('exportCsv: passes through to service', async () => {
    const deps = makeDeps();
    const route = createAdminLeadsRoute(deps);

    const result = await route.exportCsv(ADMIN_HEADERS, { status: 'won' });

    expect(result.filename).toBe('test.csv');
    expect(deps.adminLeads.exportCsv).toHaveBeenCalledWith(
      { status: 'won' },
      ADMIN_EMAIL,
    );
  });
});
