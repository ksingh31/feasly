/**
 * Admin job-queue route (#838): admin guard → query validation → one
 * service call. Role-level authorization (ops:manage → super_admin/admin
 * only, 403 for everyone else) is enforced centrally from the registry and
 * pinned by the route-registry permission-matrix snapshot.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AdminJobsResponse } from '@feasly/contracts';
import { createAdminJobsRoute } from '../src/routes/admin-jobs.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid' };

const guard = {
  async requireAdmin(headers: Record<string, string | string[] | undefined>) {
    if (headers['cookie'] !== ADMIN_HEADERS.cookie) {
      throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.', false);
    }
  },
  async getAdminEmail() {
    return null;
  },
};

const EMPTY: AdminJobsResponse = {
  counts: { pending: 0, running: 0, done: 0, dead: 0, cancelled: 0 },
  status: 'dead',
  jobs: [],
};

function route() {
  const listJobs = vi.fn().mockResolvedValue(EMPTY);
  return { listJobs, route: createAdminJobsRoute({ jobs: { listJobs }, adminGuard: guard }) };
}

describe('admin jobs route (#838)', () => {
  it('401 without an admin session, and the service is never called', async () => {
    const { route: r, listJobs } = route();
    await expect(r.list({}, {})).rejects.toMatchObject({ status: 401 });
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('defaults to the failed (dead) jobs, limit 50', async () => {
    const { route: r, listJobs } = route();
    await expect(r.list(ADMIN_HEADERS, {})).resolves.toEqual(EMPTY);
    expect(listJobs).toHaveBeenCalledWith({ status: 'dead', limit: 50 });
  });

  it('passes a valid status + limit through', async () => {
    const { route: r, listJobs } = route();
    await r.list(ADMIN_HEADERS, { status: 'pending', limit: '10' });
    expect(listJobs).toHaveBeenCalledWith({ status: 'pending', limit: 10 });
  });

  it('400 on an unknown status or out-of-range limit', async () => {
    const { route: r } = route();
    await expect(r.list(ADMIN_HEADERS, { status: 'exploded' })).rejects.toMatchObject({ status: 400 });
    await expect(r.list(ADMIN_HEADERS, { limit: '0' })).rejects.toMatchObject({ status: 400 });
    await expect(r.list(ADMIN_HEADERS, { limit: '9999' })).rejects.toMatchObject({ status: 400 });
  });
});
