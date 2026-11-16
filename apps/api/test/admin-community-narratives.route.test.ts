/**
 * Admin community-narratives routes (#759): status list serialization,
 * regenerate for one/all, body validation, 401 unauthenticated, and the
 * audit row (with the acting admin) on success and failure (AC4).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMMUNITY_NARRATIVE_REGENERATE_AUDIT_ACTION,
  createAdminCommunityNarrativesRoute,
} from '../src/routes/admin-community-narratives.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid' };
const ADMIN_EMAIL = 'ops-admin@example.com';

function makeGuard() {
  const ok = (h: Record<string, string | string[] | undefined>) =>
    h['cookie'] === 'feasly_admin_session=valid';
  return {
    async requireAdmin(h: Record<string, string | string[] | undefined>) {
      if (!ok(h)) {
        throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.', false);
      }
    },
    async getAdminEmail(h: Record<string, string | string[] | undefined>) {
      return ok(h) ? ADMIN_EMAIL : null;
    },
  };
}

function makeDeps() {
  const narratives = {
    listStatus: vi.fn().mockResolvedValue([
      {
        communitySlug: 'beltline',
        communityName: 'Beltline',
        period: '2026-12',
        status: 'succeeded',
        generatedAt: new Date('2026-11-30T09:00:00Z'),
        attempts: 1,
        lastError: null,
      },
      {
        communitySlug: 'bowness',
        communityName: 'Bowness',
        period: null,
        status: 'missing',
        generatedAt: null,
        attempts: 0,
        lastError: null,
      },
    ]),
    regenerate: vi.fn().mockResolvedValue({
      trigger: 'admin',
      period: '2026-12',
      attempted: 1,
      succeeded: 1,
      failed: 0,
      deferred: 0,
      alerted: false,
    }),
  };
  const audit = { append: vi.fn().mockResolvedValue({}) };
  const route = createAdminCommunityNarrativesRoute({
    narratives,
    audit,
    adminGuard: makeGuard(),
  });
  return { route, narratives, audit };
}

describe('admin community-narratives routes (#759)', () => {
  it('lists each community with its last generated date and status', async () => {
    const { route } = makeDeps();
    const res = await route.list(ADMIN_HEADERS);
    expect(res.communities).toEqual([
      {
        community_slug: 'beltline',
        community_name: 'Beltline',
        period: '2026-12',
        status: 'succeeded',
        generated_at: '2026-11-30T09:00:00.000Z',
        attempts: 1,
        last_error: null,
      },
      {
        community_slug: 'bowness',
        community_name: 'Bowness',
        period: null,
        status: 'missing',
        generated_at: null,
        attempts: 0,
        last_error: null,
      },
    ]);
  });

  it('401s without an admin session (list + regenerate), with no service call or audit', async () => {
    const { route, narratives, audit } = makeDeps();
    await expect(route.list({})).rejects.toMatchObject({ status: 401 });
    await expect(route.regenerate({}, {})).rejects.toMatchObject({ status: 401 });
    expect(narratives.regenerate).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('AC4: regenerates one community and audit-logs it with the admin email', async () => {
    const { route, narratives, audit } = makeDeps();
    const res = await route.regenerate(ADMIN_HEADERS, { community_slug: 'beltline' });
    expect(narratives.regenerate).toHaveBeenCalledWith({ communitySlug: 'beltline' });
    expect(res).toEqual({
      scope: 'one',
      period: '2026-12',
      attempted: 1,
      succeeded: 1,
      failed: 0,
      deferred: 0,
    });
    expect(audit.append).toHaveBeenCalledWith({
      action: COMMUNITY_NARRATIVE_REGENERATE_AUDIT_ACTION,
      actorEmail: ADMIN_EMAIL,
      detail: expect.stringContaining('ok community=beltline period=2026-12'),
    });
  });

  it('regenerates all communities for an empty body', async () => {
    const { route, narratives, audit } = makeDeps();
    const res = await route.regenerate(ADMIN_HEADERS, undefined);
    expect(narratives.regenerate).toHaveBeenCalledWith({ communitySlug: undefined });
    expect(res.scope).toBe('all');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('community=*') }),
    );
  });

  it('400s on an invalid body without calling the service', async () => {
    const { route, narratives } = makeDeps();
    await expect(
      route.regenerate(ADMIN_HEADERS, { community_slug: 'Not A Slug' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.regenerate(ADMIN_HEADERS, { community_slug: 'ok', extra: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(narratives.regenerate).not.toHaveBeenCalled();
  });

  it('audit-logs a failed regenerate and rethrows', async () => {
    const { route, narratives, audit } = makeDeps();
    narratives.regenerate.mockRejectedValueOnce(
      new HttpError(404, ErrorCodes.COMMUNITY_NOT_FOUND, 'Unknown community.', false),
    );
    await expect(
      route.regenerate(ADMIN_HEADERS, { community_slug: 'nowhere' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'error community=nowhere HttpError' }),
    );
  });
});
