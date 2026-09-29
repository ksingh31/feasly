/**
 * Comment store (BILL-05).
 *
 * The Drizzle persistence boundary for `builder_comments`. The visibility
 * filter lives HERE, in SQL — `listByEntity` adds `visibility = 'org'`
 * to the WHERE clause unless the caller explicitly opts into admin-only
 * rows. The service decides the flag; the store enforces it. Filtering
 * in JS after the fact would be a leak vector, so there is no code path
 * that loads admin_only rows and drops them in memory.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { builderComments } from '../db/schema';

export type CommentRow = typeof builderComments.$inferSelect;

export interface NewCommentRow {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly authorKind: 'builder' | 'admin';
  readonly authorId: string;
  readonly visibility: 'org' | 'admin_only';
  readonly body: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CommentStore {
  /**
   * Chronological (oldest first) non-deleted comments for an entity.
   * `includeAdminOnly: false` appends `visibility = 'org'` to the WHERE
   * clause — the builder read path. Admin callers pass true.
   */
  listByEntity(args: {
    readonly entityType: string;
    readonly entityId: string;
    readonly includeAdminOnly: boolean;
  }): Promise<CommentRow[]>;
  /** A single comment by id, including soft-deleted rows (null when absent). */
  getById(id: string): Promise<CommentRow | null>;
  insert(row: NewCommentRow): Promise<CommentRow>;
  /** Author edit: rewrites the body and bumps updated_at. */
  updateBody(args: {
    readonly id: string;
    readonly body: string;
    readonly updatedAt: Date;
  }): Promise<CommentRow | null>;
  /** Admin moderation: stamps deleted_at; the row is never hard-deleted. */
  softDelete(args: { readonly id: string; readonly deletedAt: Date }): Promise<void>;
}

export interface DrizzleCommentStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleCommentStore(
  deps: DrizzleCommentStoreDeps,
): CommentStore {
  const { db } = deps;

  return {
    async listByEntity(args): Promise<CommentRow[]> {
      const rows = await db
        .select()
        .from(builderComments)
        .where(
          and(
            eq(builderComments.entityType, args.entityType),
            eq(builderComments.entityId, args.entityId),
            isNull(builderComments.deletedAt),
            // THE visibility gate: admin_only rows never leave the database
            // on the builder path. Not a JS filter — part of the query.
            args.includeAdminOnly
              ? undefined
              : eq(builderComments.visibility, 'org'),
          ),
        )
        .orderBy(asc(builderComments.createdAt), asc(builderComments.id));
      return rows;
    },

    async getById(id): Promise<CommentRow | null> {
      const rows = await db
        .select()
        .from(builderComments)
        .where(eq(builderComments.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async insert(row): Promise<CommentRow> {
      const rows = await db.insert(builderComments).values(row).returning();
      const inserted = rows[0];
      if (!inserted) throw new Error('comment insert returned no row');
      return inserted;
    },

    async updateBody(args): Promise<CommentRow | null> {
      const rows = await db
        .update(builderComments)
        .set({ body: args.body, updatedAt: args.updatedAt })
        .where(eq(builderComments.id, args.id))
        .returning();
      return rows[0] ?? null;
    },

    async softDelete(args): Promise<void> {
      await db
        .update(builderComments)
        .set({ deletedAt: args.deletedAt })
        .where(eq(builderComments.id, args.id));
    },
  };
}
