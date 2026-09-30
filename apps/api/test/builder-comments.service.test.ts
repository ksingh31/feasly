/**
 * BILL-05 — lead comments service tests.
 *
 * Covers the one shared service behind both the builder and the admin
 * routes:
 * - builder writes are forced to `org` visibility (client-sent
 *   `admin_only` is silently downgraded)
 * - admin writes default to `admin_only`
 * - the visibility exclusion is delegated to the store's SQL filter
 *   (the service passes `includeAdminOnly: false` for builders and never
 *   filters rows in JS — the fake store honors the flag like the real
 *   Drizzle query does)
 * - cross-org builder access → 404
 * - author-only edits (builder AND admin) → 403 for others' comments
 * - admin soft-delete keeps the row; both read paths exclude it
 * - 2000-char body cap, HTML escaping on read
 * - frozen contract shape on the wire
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { HttpError } from '../src/middleware/errors';
import {
  createBuilderCommentsService,
  type BuilderCommentsService,
  type CommentActor,
} from '../src/services/builder-comments.service';
import type {
  CommentRow,
  CommentStore,
  NewCommentRow,
} from '../src/services/builder-comments.store';

const BUILDER_ID = 'b1111111-1111-4111-8111-111111111111';
const OTHER_BUILDER_ID = 'b2222222-2222-4222-8222-222222222222';
const LEAD_ID = 'c1111111-1111-4111-8111-111111111111';
const OTHER_LEAD_ID = 'c2222222-2222-4222-8222-222222222222';
const USER_ID = 'd1111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = 'd2222222-2222-4222-8222-222222222222';
const ADMIN_USER_ID = 'd3333333-3333-4333-8333-333333333333';

function row(overrides: Partial<CommentRow> & { id: string }): CommentRow {
  const now = new Date('2026-09-29T12:00:00.000Z');
  return {
    entityType: 'lead',
    entityId: LEAD_ID,
    authorKind: 'builder',
    authorId: USER_ID,
    visibility: 'org',
    body: 'hello',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makeStore(seed: CommentRow[] = []): CommentStore & {
  rows: CommentRow[];
  seenListArgs: Array<{ includeAdminOnly: boolean }>;
} {
  const rows = [...seed];
  const seenListArgs: Array<{ includeAdminOnly: boolean }> = [];
  return {
    rows,
    seenListArgs,
    async listByEntity(args) {
      seenListArgs.push({ includeAdminOnly: args.includeAdminOnly });
      // Mirrors the real Drizzle query: the visibility predicate is part
      // of the WHERE clause; deleted rows are excluded too.
      return rows
        .filter((r) => r.entityType === args.entityType)
        .filter((r) => r.entityId === args.entityId)
        .filter((r) => r.deletedAt === null)
        .filter((r) => args.includeAdminOnly || r.visibility === 'org')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async getById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async insert(newRow: NewCommentRow) {
      const inserted = row({ ...newRow });
      rows.push(inserted);
      return inserted;
    },
    async updateBody(args) {
      const found = rows.find((r) => r.id === args.id);
      if (!found) return null;
      found.body = args.body;
      found.updatedAt = args.updatedAt;
      return found;
    },
    async softDelete(args) {
      const found = rows.find((r) => r.id === args.id);
      if (found) found.deletedAt = args.deletedAt;
    },
    async summariesByEntity(args) {
      // Mirrors the real window-function query: per-entity count plus
      // the newest visible row, with the same SQL visibility gate.
      const visible = rows
        .filter((r) => r.entityType === args.entityType)
        .filter((r) => args.entityIds.includes(r.entityId))
        .filter((r) => r.deletedAt === null)
        .filter((r) => args.includeAdminOnly || r.visibility === 'org')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const byEntity = new Map<string, CommentRow[]>();
      for (const r of visible) {
        const list = byEntity.get(r.entityId) ?? [];
        list.push(r);
        byEntity.set(r.entityId, list);
      }
      return new Map(
        [...byEntity].map(([entityId, list]) => [
          entityId,
          {
            count: list.length,
            latest:
              list[0] === undefined
                ? null
                : {
                    body: list[0].body,
                    authorId: list[0].authorId,
                    authorKind: list[0].authorKind as 'builder' | 'admin',
                    createdAt: list[0].createdAt,
                  },
          },
        ]),
      );
    },
  };
}

function makeService(store: CommentStore): {
  service: BuilderCommentsService;
  spies: { findByIdAndBuilderId: ReturnType<typeof vi.fn> };
} {
  const findByIdAndBuilderId = vi.fn(
    async (args: { id: string; builderId: string }) => {
      if (args.builderId === BUILDER_ID && args.id === LEAD_ID) {
        return { id: LEAD_ID, builderId: BUILDER_ID } as never;
      }
      return null;
    },
  );
  const service = createBuilderCommentsService({
    comments: store,
    builders: {
      getByTenantKey: async (tenantKey: string) =>
        tenantKey === 'acme'
          ? ({ id: BUILDER_ID, status: 'active' } as never)
          : null,
    },
    leadStore: {
      findById: async (id: string) =>
        id === LEAD_ID || id === OTHER_LEAD_ID
          ? ({ id, builderId: BUILDER_ID } as never)
          : null,
      findByIdAndBuilderId,
    },
    users: {
      findByEmail: async (email: string) => {
        const map: Record<string, { id: string; name: string }> = {
          'builder@example.com': { id: USER_ID, name: 'Mya Builder' },
          'other@example.com': { id: OTHER_USER_ID, name: 'Other Builder' },
          'admin@example.com': { id: ADMIN_USER_ID, name: 'Owen Admin' },
        };
        const hit = map[email];
        return hit
          ? ({ id: hit.id, email, name: hit.name } as never)
          : null;
      },
      findById: async (id: string) => {
        const map: Record<string, { name: string; email: string }> = {
          [USER_ID]: { name: 'Mya Builder', email: 'builder@example.com' },
          [OTHER_USER_ID]: { name: 'Other Builder', email: 'other@example.com' },
          [ADMIN_USER_ID]: { name: 'Owen Admin', email: 'admin@example.com' },
        };
        const hit = map[id];
        return hit ? ({ id, name: hit.name, email: hit.email } as never) : null;
      },
    },
    uuid: () => 'e1111111-1111-4111-8111-111111111111',
    clock: () => new Date('2026-09-29T12:00:00.000Z'),
  });
  return { service, spies: { findByIdAndBuilderId } };
}

const builderActor: CommentActor = {
  kind: 'builder',
  email: 'builder@example.com',
  tenantKey: 'acme',
};
const otherBuilderActor: CommentActor = {
  kind: 'builder',
  email: 'other@example.com',
  tenantKey: 'acme',
};
const adminActor: CommentActor = {
  kind: 'admin',
  email: 'admin@example.com',
};

async function expectHttpError(
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

describe('builder-comments.service', () => {
  let store: ReturnType<typeof makeStore>;
  let service: BuilderCommentsService;

  beforeEach(() => {
    store = makeStore();
    service = makeService(store).service;
  });

  describe('contract shape (frozen for BILL-06/07)', () => {
    it('serializes exactly the frozen Comment fields', async () => {
      const comment = await service.createComment({
        entityType: 'lead',
        entityId: LEAD_ID,
        body: '  looks good  ',
        visibility: undefined,
        actor: builderActor,
      });
      expect(Object.keys(comment).sort()).toEqual(
        [
          'authorDisplayName',
          'authorId',
          'authorKind',
          'body',
          'createdAt',
          'deletedAt',
          'edited',
          'entityId',
          'entityType',
          'id',
          'updatedAt',
          'visibility',
        ].sort(),
      );
      expect(comment).toMatchObject({
        entityType: 'lead',
        entityId: LEAD_ID,
        authorKind: 'builder',
        authorId: 'builder@example.com',
        authorDisplayName: 'Mya Builder',
        visibility: 'org',
        body: 'looks good',
        edited: false,
        deletedAt: null,
      });
      expect(typeof comment.createdAt).toBe('string');
      expect(typeof comment.updatedAt).toBe('string');
    });
  });

  describe('builder reads', () => {
    it('excludes admin_only rows and asks the store for org-only SQL', async () => {
      store.rows.push(
        row({ id: 'org-1', visibility: 'org', body: 'builder-visible' }),
        row({
          id: 'adm-1',
          visibility: 'admin_only',
          authorKind: 'admin',
          authorId: ADMIN_USER_ID,
          body: 'internal only',
        }),
      );
      const res = await service.listComments({
        entityType: 'lead',
        entityId: LEAD_ID,
        actor: builderActor,
      });
      expect(res.comments.map((c) => c.id)).toEqual(['org-1']);
      // The visibility exclusion is a SQL predicate, not a JS filter:
      // the service must pass includeAdminOnly=false to the store.
      expect(store.seenListArgs).toEqual([{ includeAdminOnly: false }]);
      // And the wire JSON carries no trace of the internal note.
      expect(JSON.stringify(res)).not.toContain('internal only');
      expect(JSON.stringify(res)).not.toContain('admin_only');
    });

    it('returns 404 for a lead that belongs to another builder', async () => {
      await expectHttpError(
        service.listComments({
          entityType: 'lead',
          entityId: OTHER_LEAD_ID,
          actor: builderActor,
        }),
        404,
      );
    });

    it('returns 404 for an unknown tenant key', async () => {
      await expectHttpError(
        service.listComments({
          entityType: 'lead',
          entityId: LEAD_ID,
          actor: { ...builderActor, tenantKey: 'nope' },
        }),
        404,
      );
    });
  });

  describe('builder writes', () => {
    it('forces visibility=org even when the body requests admin_only', async () => {
      const comment = await service.createComment({
        entityType: 'lead',
        entityId: LEAD_ID,
        body: 'note',
        visibility: 'admin_only',
        actor: builderActor,
      });
      expect(comment.visibility).toBe('org');
      expect(store.rows[0]?.visibility).toBe('org');
    });

    it('rejects bodies over 2000 chars and empty bodies', async () => {
      await expectHttpError(
        service.createComment({
          entityType: 'lead',
          entityId: LEAD_ID,
          body: 'x'.repeat(2001),
          visibility: undefined,
          actor: builderActor,
        }),
        400,
      );
      await expectHttpError(
        service.createComment({
          entityType: 'lead',
          entityId: LEAD_ID,
          body: '   ',
          visibility: undefined,
          actor: builderActor,
        }),
        400,
      );
    });

    it('edits its own comment and marks it edited', async () => {
      store.rows.push(
        row({
          id: 'c1',
          body: 'v1',
          createdAt: new Date('2026-09-28T12:00:00.000Z'),
          updatedAt: new Date('2026-09-28T12:00:00.000Z'),
        }),
      );
      const updated = await service.updateComment({
        commentId: 'c1',
        body: 'v2',
        actor: builderActor,
      });
      expect(updated.body).toBe('v2');
      expect(updated.edited).toBe(true);
      expect(store.rows[0]?.body).toBe('v2');
    });

    it('returns 403 when editing another user\'s comment', async () => {
      store.rows.push(
        row({ id: 'c1', authorId: OTHER_USER_ID, authorKind: 'builder' }),
      );
      await expectHttpError(
        service.updateComment({
          commentId: 'c1',
          body: 'hijack',
          actor: builderActor,
        }),
        403,
      );
      expect(store.rows[0]?.body).toBe('hello');
    });

    it('returns 403 when a builder edits an admin comment', async () => {
      store.rows.push(
        row({
          id: 'c1',
          authorId: ADMIN_USER_ID,
          authorKind: 'admin',
          visibility: 'org',
        }),
      );
      await expectHttpError(
        service.updateComment({
          commentId: 'c1',
          body: 'hijack',
          actor: builderActor,
        }),
        403,
      );
    });

    it('rejects delete attempts from builders (no builder DELETE route)', async () => {
      store.rows.push(row({ id: 'c1' }));
      await expectHttpError(
        service.deleteComment({ commentId: 'c1', actor: builderActor }),
        403,
      );
      expect(store.rows[0]?.deletedAt).toBeNull();
    });
  });

  describe('admin reads/writes', () => {
    it('includes admin_only rows and asks the store for the full thread', async () => {
      store.rows.push(
        row({ id: 'org-1', visibility: 'org' }),
        row({
          id: 'adm-1',
          visibility: 'admin_only',
          authorKind: 'admin',
          authorId: ADMIN_USER_ID,
        }),
      );
      const res = await service.listComments({
        entityType: 'lead',
        entityId: LEAD_ID,
        actor: adminActor,
      });
      expect(res.comments.map((c) => c.id).sort()).toEqual(['adm-1', 'org-1']);
      expect(store.seenListArgs).toEqual([{ includeAdminOnly: true }]);
    });

    it('defaults new comments to admin_only; honors explicit org', async () => {
      const internal = await service.createComment({
        entityType: 'lead',
        entityId: LEAD_ID,
        body: 'internal',
        visibility: undefined,
        actor: adminActor,
      });
      expect(internal.visibility).toBe('admin_only');
      expect(internal.authorKind).toBe('admin');

      const shared = await service.createComment({
        entityType: 'lead',
        entityId: LEAD_ID,
        body: 'shared',
        visibility: 'org',
        actor: adminActor,
      });
      expect(shared.visibility).toBe('org');
    });

    it('rejects an invalid visibility value', async () => {
      await expectHttpError(
        service.createComment({
          entityType: 'lead',
          entityId: LEAD_ID,
          body: 'x',
          visibility: 'everyone',
          actor: adminActor,
        }),
        400,
      );
    });

    it('lets an admin edit their own comment, but not a builder\'s', async () => {
      store.rows.push(
        row({
          id: 'adm-1',
          authorKind: 'admin',
          authorId: ADMIN_USER_ID,
          visibility: 'admin_only',
        }),
        row({ id: 'org-1', authorId: USER_ID, authorKind: 'builder' }),
      );
      const updated = await service.updateComment({
        commentId: 'adm-1',
        body: 'revised internal',
        actor: adminActor,
      });
      expect(updated.body).toBe('revised internal');

      await expectHttpError(
        service.updateComment({
          commentId: 'org-1',
          body: 'rewriting your words',
          actor: adminActor,
        }),
        403,
      );
      expect(store.rows.find((r) => r.id === 'org-1')?.body).toBe('hello');
    });

    it('soft-deletes: the row survives, both read paths exclude it', async () => {
      store.rows.push(row({ id: 'c1', visibility: 'org' }));
      const res = await service.deleteComment({
        commentId: 'c1',
        actor: adminActor,
      });
      expect(res).toEqual({ ok: true });
      // Row retained in the database (soft delete, never hard).
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]?.deletedAt).not.toBeNull();

      const adminList = await service.listComments({
        entityType: 'lead',
        entityId: LEAD_ID,
        actor: adminActor,
      });
      const builderList = await service.listComments({
        entityType: 'lead',
        entityId: LEAD_ID,
        actor: builderActor,
      });
      expect(adminList.comments).toHaveLength(0);
      expect(builderList.comments).toHaveLength(0);

      // Deleting twice is 404 (already gone), not a second write.
      await expectHttpError(
        service.deleteComment({ commentId: 'c1', actor: adminActor }),
        404,
      );
    });
  });

  describe('authorship + identity', () => {
    it('returns 403 when the session email has no user row', async () => {
      await expectHttpError(
        service.createComment({
          entityType: 'lead',
          entityId: LEAD_ID,
          body: 'x',
          visibility: undefined,
          actor: { ...builderActor, email: 'ghost@example.com' },
        }),
        403,
      );
    });

    it('derives authorDisplayName from the users table on read', async () => {
      store.rows.push(
        row({ id: 'c1', authorId: OTHER_USER_ID, authorKind: 'builder' }),
      );
      const res = await service.listComments({
        entityType: 'lead',
        entityId: LEAD_ID,
        actor: adminActor,
      });
      expect(res.comments[0]?.authorDisplayName).toBe('Other Builder');
      // The wire authorId is the author's email — the identity the UI
      // matches its session against for the "edit own comment" affordance.
      expect(res.comments[0]?.authorId).toBe('other@example.com');
    });
  });

  describe('output safety', () => {
    it('returns the body pristine on read — Angular interpolation is the single escaping layer', async () => {
      const raw = `<script>alert("x")</script> & 'quotes'`;
      await service.createComment({
        entityType: 'lead',
        entityId: LEAD_ID,
        body: raw,
        visibility: undefined,
        actor: builderActor,
      });
      expect(store.rows[0]?.body).toBe(raw);

      const res = await service.listComments({
        entityType: 'lead',
        entityId: LEAD_ID,
        actor: builderActor,
      });
      // No server-side escaping: the SPA renders with {{ }} interpolation,
      // which escapes exactly once. Escaping here would double-escape.
      expect(res.comments[0]?.body).toBe(raw);
    });
  });
});
