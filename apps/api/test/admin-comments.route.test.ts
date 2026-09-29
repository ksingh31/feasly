/**
 * Unit tests for the admin comments route (BILL-05).
 *
 * Verifies:
 * - All endpoints require admin auth (401 without it).
 * - list/create/update/delete validate the lead/comment id params.
 * - create forwards visibility to the service (the SERVICE applies the
 *   admin_only default — the route must not invent one).
 * - delete delegates to the service (soft delete).
 *
 * Fakes the BuilderCommentsService interface; no DB. Tests run under vitest.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createAdminCommentsRoute,
  type AdminCommentsRouteDeps,
} from '../src/routes/admin-comments.route';
import type { AdminGuard } from '../src/middleware/admin-guard';
import type { BuilderCommentsService } from '../src/services/builder-comments.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const VALID_SESSION = 'feasly_admin_session=valid-test-session';
const LEAD_ID = '123e4567-e89b-12d3-a456-426614174000';
const COMMENT_ID = '123e4567-e89b-12d3-a456-426614174001';

function makeDeps() {
  const comments = {
    listComments: vi.fn(async () => ({ comments: [] })),
    createComment: vi.fn(async (args: { body: unknown }) => ({
      id: COMMENT_ID,
      body: args.body,
    })),
    updateComment: vi.fn(async (args: { body: unknown }) => ({
      id: COMMENT_ID,
      body: args.body,
    })),
    deleteComment: vi.fn(async () => ({ ok: true as const })),
  } as unknown as BuilderCommentsService;

  const adminGuard = {
    async requireAdmin(
      headers: Record<string, string | string[] | undefined>,
    ) {
      const cookie = headers['cookie'];
      const value = Array.isArray(cookie) ? cookie[0] : cookie;
      if (value !== VALID_SESSION) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Admin authentication required.',
          false,
        );
      }
    },
    getAdminEmail(
      headers: Record<string, string | string[] | undefined>,
    ): string | null {
      const cookie = headers['cookie'];
      const value = Array.isArray(cookie) ? cookie[0] : cookie;
      return value === VALID_SESSION ? 'admin@example.com' : null;
    },
  } as unknown as AdminGuard;

  const route = createAdminCommentsRoute({ comments, adminGuard });
  return { route, comments };
}

const headers = { cookie: VALID_SESSION };

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
): Promise<void> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    return;
  }
  throw new Error(`expected HttpError ${status}, but the call succeeded`);
}

describe('admin-comments.route', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('requires admin auth on every endpoint (401)', async () => {
    const bad = {};
    await expectHttpError(deps.route.listLeadComments(bad, LEAD_ID), 401);
    await expectHttpError(
      deps.route.createLeadComment(bad, LEAD_ID, { body: 'x' }),
      401,
    );
    await expectHttpError(
      deps.route.updateComment(bad, COMMENT_ID, { body: 'x' }),
      401,
    );
    await expectHttpError(deps.route.deleteComment(bad, COMMENT_ID), 401);
  });

  it('rejects non-uuid ids with 400', async () => {
    await expectHttpError(deps.route.listLeadComments(headers, 'nope'), 400);
    await expectHttpError(
      deps.route.createLeadComment(headers, 'nope', { body: 'x' }),
      400,
    );
    await expectHttpError(
      deps.route.updateComment(headers, 'nope', { body: 'x' }),
      400,
    );
    await expectHttpError(deps.route.deleteComment(headers, 'nope'), 400);
  });

  it('delegates list to the service with an admin actor', async () => {
    await deps.route.listLeadComments(headers, LEAD_ID);
    const call = (deps.comments.listComments as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(call.entityType).toBe('lead');
    expect(call.entityId).toBe(LEAD_ID);
    expect(call.actor).toMatchObject({
      kind: 'admin',
      email: 'admin@example.com',
    });
  });

  it('forwards create input untouched — the service applies the admin_only default', async () => {
    await deps.route.createLeadComment(headers, LEAD_ID, { body: 'hi' });
    const call = (deps.comments.createComment as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(call.entityId).toBe(LEAD_ID);
    expect(call.body).toBe('hi');
    expect(call.visibility).toBeUndefined();
    expect(call.actor.kind).toBe('admin');
  });

  it('delegates update and delete to the service', async () => {
    await deps.route.updateComment(headers, COMMENT_ID, { body: 'v2' });
    const updateCall = (
      deps.comments.updateComment as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    expect(updateCall.commentId).toBe(COMMENT_ID);
    expect(updateCall.body).toBe('v2');
    expect(updateCall.actor.kind).toBe('admin');

    const res = await deps.route.deleteComment(headers, COMMENT_ID);
    expect(res).toEqual({ ok: true });
    const deleteCall = (
      deps.comments.deleteComment as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    expect(deleteCall.commentId).toBe(COMMENT_ID);
    expect(deleteCall.actor.kind).toBe('admin');
  });
});

export type { AdminCommentsRouteDeps };
