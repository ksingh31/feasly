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
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
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

export interface CommentSummaryLatest {
  readonly body: string;
  /** users.id — the service resolves this to a display name. */
  readonly authorId: string;
  readonly authorKind: 'builder' | 'admin';
  readonly createdAt: Date;
}

export interface CommentSummary {
  /** Builder-visible (per includeAdminOnly) non-deleted comment count. */
  readonly count: number;
  /** Newest visible comment. Non-null whenever the entity is in the map. */
  readonly latest: CommentSummaryLatest | null;
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
  /**
   * Per-entity comment counts + newest comment in ONE query (drives the
   * lead list's notes badges — no N+1 thread fetches). The visibility
   * gate is identical to listByEntity: `includeAdminOnly: false`
   * appends `visibility = 'org'` in SQL. Entities with zero visible
   * comments are absent from the map.
   */
  summariesByEntity(args: {
    readonly entityType: string;
    readonly entityIds: readonly string[];
    readonly includeAdminOnly: boolean;
  }): Promise<ReadonlyMap<string, CommentSummary>>;
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

    async summariesByEntity(args): Promise<ReadonlyMap<string, CommentSummary>> {
      if (args.entityIds.length === 0) {
        return new Map();
      }
      // Single pass: window functions compute the per-entity count and
      // rank rows newest-first; the outer query keeps rank 1. The
      // visibility gate stays in SQL — same rule as listByEntity, so an
      // admin_only row can never inflate a builder's badge.
      const ranked = db
        .select({
          entityId: builderComments.entityId,
          body: builderComments.body,
          authorId: builderComments.authorId,
          authorKind: builderComments.authorKind,
          createdAt: builderComments.createdAt,
          count: sql<number>`count(*) over (partition by ${builderComments.entityId})`
            .mapWith(Number)
            .as('comment_count'),
          rn: sql<number>`row_number() over (partition by ${builderComments.entityId} order by ${builderComments.createdAt} desc, ${builderComments.id} desc)`
            .mapWith(Number)
            .as('rn'),
        })
        .from(builderComments)
        .where(
          and(
            eq(builderComments.entityType, args.entityType),
            inArray(builderComments.entityId, [...args.entityIds]),
            isNull(builderComments.deletedAt),
            // THE visibility gate, same as listByEntity.
            args.includeAdminOnly
              ? undefined
              : eq(builderComments.visibility, 'org'),
          ),
        )
        .as('ranked');
      const rows = await db.select().from(ranked).where(eq(ranked.rn, 1));
      const out = new Map<string, CommentSummary>();
      for (const row of rows) {
        out.set(row.entityId, {
          count: row.count,
          latest: {
            body: row.body,
            authorId: row.authorId,
            authorKind: row.authorKind as 'builder' | 'admin',
            createdAt: row.createdAt,
          },
        });
      }
      return out;
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
