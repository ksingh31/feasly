/**
 * Unit tests for the builder comments route (BILL-05).
 *
 * Verifies:
 * - All endpoints require a builder session (401 without one).
 * - list/create/update validate the lead/comment id params (400 on junk).
 * - create forwards the raw body to the service (the SERVICE forces
 *   visibility=org — the route must not second-guess it).
 * - update forwards to the service.
 *
 * Fakes the BuilderCommentsService interface; no DB. Tests run under vitest.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createBuilderCommentsRoute,
  type BuilderCommentsRouteDeps,
} from '../src/routes/builder-comments.route';
import type { BuilderGuard } from '../src/middleware/builder-guard';
import type { BuilderCommentsService } from '../src/services/builder-comments.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const VALID_SESSION = 'feasly_builder_session=valid-test-session';
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
    deleteComment: vi.fn(async () => {
      throw new HttpError(403, ErrorCodes.FORBIDDEN, 'nope', false);
    }),
  } as unknown as BuilderCommentsService;

  const builderGuard = {
    async getBuilderSession(
      headers: Record<string, string | string[] | undefined>,
    ) {
      const cookie = headers['cookie'];
      const value = Array.isArray(cookie) ? cookie[0] : cookie;
      if (value !== VALID_SESSION) return null;
      return {
        email: 'builder@example.com',
        tenantKey: 'acme',
        builderId: 'b1',
      };
    },
    async requireBuilder(
      headers: Record<string, string | string[] | undefined>,
    ) {
      const session = await builderGuard.getBuilderSession(headers);
      if (!session) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Builder authentication required.',
          false,
        );
      }
      return session;
    },
  } as unknown as BuilderGuard;

  const route = createBuilderCommentsRoute({ comments, builderGuard });
  return { route, comments, builderGuard };
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

describe('builder-comments.route', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('requires a builder session on every endpoint (401)', async () => {
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
  });

  it('delegates list to the service with a builder actor', async () => {
    await deps.route.listLeadComments(headers, LEAD_ID);
    const call = (deps.comments.listComments as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(call.entityType).toBe('lead');
    expect(call.entityId).toBe(LEAD_ID);
    expect(call.actor).toMatchObject({
      kind: 'builder',
      email: 'builder@example.com',
      tenantKey: 'acme',
    });
  });

  it('forwards create input untouched — the service forces visibility', async () => {
    // The route must NOT strip or rewrite visibility: the service owns
    // the "builder forces org" rule. Assert the raw value reaches it.
    await deps.route.createLeadComment(headers, LEAD_ID, {
      body: 'hi',
      visibility: 'admin_only',
    });
    const call = (deps.comments.createComment as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(call.entityType).toBe('lead');
    expect(call.entityId).toBe(LEAD_ID);
    expect(call.body).toBe('hi');
    expect(call.visibility).toBe('admin_only');
    expect(call.actor.kind).toBe('builder');
  });

  it('delegates update to the service', async () => {
    await deps.route.updateComment(headers, COMMENT_ID, { body: 'v2' });
    const call = (deps.comments.updateComment as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(call.commentId).toBe(COMMENT_ID);
    expect(call.body).toBe('v2');
    expect(call.actor.kind).toBe('builder');
  });

  it('exposes no delete method (builders cannot delete comments)', () => {
    expect(
      (deps.route as unknown as Record<string, unknown>)['deleteComment'],
    ).toBeUndefined();
  });
});

export type { BuilderCommentsRouteDeps };
