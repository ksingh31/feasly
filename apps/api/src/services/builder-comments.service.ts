/**
 * Lead comments service (BILL-05).
 *
 * ONE service serves both the builder and the admin routes — the
 * visibility filter is a parameter (`includeAdminOnly`), not two code
 * paths. The builder read path can never return `admin_only` rows because
 * the store adds `visibility = 'org'` to the SQL WHERE clause; there is
 * no JS-side filtering to get wrong.
 *
 * Scoping (follows the builder-leads.service.ts pattern):
 * - Builder callers pass `{ kind: 'builder', email, tenantKey }`.
 *   `requireBuilder(tenantKey)` resolves the session to exactly one
 *   builder row; unknown/inactive → 404. Every lead access re-verifies
 *   the lead belongs to that builder (`findByIdAndBuilderId`) — a
 *   builder asking for another org's lead gets 404, never a leak.
 * - Admin callers pass `{ kind: 'admin', email }`. No org scoping;
 *   `includeAdminOnly` is true on reads.
 *
 * Authorship: the comment's `author_id` is the `users.id` resolved from
 * the session email at write time, and `authorDisplayName` is the user's
 * name. A session with no user row (legacy magic-link) gets 403 — the
 * portal's org picker already requires a user row, so this is
 * consistent. Author-only edit: `author_id` must equal the caller's user
 * id, for builders AND admins alike.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Comment,
  CommentAuthorKind,
  CommentEntityType,
  CommentListResponse,
  CommentVisibility,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { BuilderService } from './builder.service';
import type { LeadStore } from './lead.store';
import type { UserStore } from './user.service';
import type { CommentRow, CommentStore } from './builder-comments.store';

export type CommentActor =
  | {
      readonly kind: 'builder';
      readonly email: string;
      readonly tenantKey: string;
    }
  | { readonly kind: 'admin'; readonly email: string };

export interface BuilderCommentsServiceDeps {
  readonly comments: CommentStore;
  readonly builders: Pick<BuilderService, 'getByTenantKey'>;
  readonly leadStore: Pick<LeadStore, 'findById' | 'findByIdAndBuilderId'>;
  readonly users: Pick<UserStore, 'findByEmail' | 'findById'>;
  readonly uuid?: () => string;
  readonly clock?: () => Date;
}

export interface BuilderCommentsService {
  listComments(args: {
    readonly entityType: string;
    readonly entityId: string;
    readonly actor: CommentActor;
  }): Promise<CommentListResponse>;
  createComment(args: {
    readonly entityType: string;
    readonly entityId: string;
    readonly body: unknown;
    readonly visibility: unknown;
    readonly actor: CommentActor;
  }): Promise<Comment>;
  updateComment(args: {
    readonly commentId: string;
    readonly body: unknown;
    readonly actor: CommentActor;
  }): Promise<Comment>;
  deleteComment(args: {
    readonly commentId: string;
    readonly actor: CommentActor;
  }): Promise<{ readonly ok: true }>;
}

/** v1 supports leads only — the table is generic for the future. */
const ENTITY_TYPES = ['lead'] as const;

const bodySchema = z.string().trim().min(1).max(2000);

const visibilitySchema = z.enum(['org', 'admin_only']);

/** Escape HTML on READ — stored bodies stay pristine, wire bodies are text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toContract(
  row: CommentRow,
  authorDisplayName: string,
): Comment {
  return {
    id: row.id,
    entityType: row.entityType as CommentEntityType,
    entityId: row.entityId,
    authorKind: row.authorKind as CommentAuthorKind,
    authorId: row.authorId,
    authorDisplayName,
    visibility: row.visibility as CommentVisibility,
    body: escapeHtml(row.body),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    edited: row.updatedAt.getTime() > row.createdAt.getTime(),
    deletedAt: null,
  };
}

export function createBuilderCommentsService(
  deps: BuilderCommentsServiceDeps,
): BuilderCommentsService {
  const {
    comments,
    builders,
    leadStore,
    users,
    uuid = randomUUID,
    clock = () => new Date(),
  } = deps;

  async function requireBuilder(tenantKey: string) {
    const builder = await builders.getByTenantKey(tenantKey);
    if (builder === null || builder.status !== 'active') {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.', false);
    }
    return builder;
  }

  /**
   * Resolve the session email to the user row. The comment's author_id is
   * the users.id — stable across sessions, and what the author-only edit
   * check compares against.
   */
  async function requireAuthor(email: string) {
    const user = await users.findByEmail(email.toLowerCase().trim());
    if (!user) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'Commenting requires an org user account.',
        false,
      );
    }
    return user;
  }

  function parseEntityType(entityType: string): 'lead' {
    if (!(ENTITY_TYPES as readonly string[]).includes(entityType)) {
      throw new HttpError(
        400,
        ErrorCodes.VALIDATION_FAILED,
        `Unsupported comment entity type: ${entityType}.`,
        false,
      );
    }
    return entityType as 'lead';
  }

  function parseBody(body: unknown): string {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        ErrorCodes.VALIDATION_FAILED,
        'Comment body must be 1–2000 characters.',
        false,
      );
    }
    return parsed.data;
  }

  /**
   * Verify the lead exists and the caller may see it. Builder callers get
   * 404 unless the lead belongs to their builder (cross-org isolation);
   * admins get 404 only when the lead doesn't exist at all.
   */
  async function requireVisibleLead(
    entityId: string,
    actor: CommentActor,
  ): Promise<{ readonly builderId: string | null }> {
    if (actor.kind === 'builder') {
      const builder = await requireBuilder(actor.tenantKey);
      const lead = await leadStore.findByIdAndBuilderId({
        id: entityId,
        builderId: builder.id,
      });
      if (!lead) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }
      return { builderId: builder.id };
    }
    const lead = await leadStore.findById(entityId);
    if (!lead) {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
    }
    return { builderId: lead.builderId ?? null };
  }

  /**
   * Resolve the current display name for an author id. The user row is
   * the source of truth; fall back to 'Unknown' when the user is gone.
   */
  async function displayNameFor(authorId: string): Promise<string> {
    const user = await users.findById(authorId).catch(() => null);
    return user?.name?.trim() ? user.name : 'Unknown';
  }

  return {
    async listComments(args): Promise<CommentListResponse> {
      const entityType = parseEntityType(args.entityType);
      await requireVisibleLead(args.entityId, args.actor);
      const includeAdminOnly = args.actor.kind === 'admin';
      const rows = await comments.listByEntity({
        entityType,
        entityId: args.entityId,
        includeAdminOnly,
      });
      const out: Comment[] = [];
      for (const row of rows) {
        out.push(toContract(row, await displayNameFor(row.authorId)));
      }
      return { comments: out };
    },

    async createComment(args): Promise<Comment> {
      const entityType = parseEntityType(args.entityType);
      const body = parseBody(args.body);
      const author = await requireAuthor(args.actor.email);
      await requireVisibleLead(args.entityId, args.actor);

      // The builder path FORCES org visibility server-side — a request
      // body claiming admin_only is silently downgraded. Admins get the
      // requested visibility, defaulting to admin_only (safe default).
      let visibility: CommentVisibility = 'org';
      if (args.actor.kind === 'admin') {
        const parsed = z
          .enum(['org', 'admin_only'])
          .optional()
          .safeParse(args.visibility);
        if (!parsed.success) {
          throw new HttpError(
            400,
            ErrorCodes.VALIDATION_FAILED,
            'Invalid comment visibility.',
            false,
          );
        }
        visibility = parsed.data ?? 'admin_only';
      } else if (args.visibility !== undefined) {
        const parsed = visibilitySchema.optional().safeParse(args.visibility);
        if (!parsed.success) {
          throw new HttpError(
            400,
            ErrorCodes.VALIDATION_FAILED,
            'Invalid comment visibility.',
            false,
          );
        }
        // Validated but ignored: builder comments are always org-visible.
      }

      const now = clock();
      const row = await comments.insert({
        id: uuid(),
        entityType,
        entityId: args.entityId,
        authorKind: args.actor.kind,
        authorId: author.id,
        visibility,
        body,
        createdAt: now,
        updatedAt: now,
      });
      return toContract(row, author.name);
    },

    async updateComment(args): Promise<Comment> {
      const body = parseBody(args.body);
      const author = await requireAuthor(args.actor.email);
      const row = await comments.getById(args.commentId);
      if (!row || row.deletedAt) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Comment not found.', false);
      }
      await requireVisibleLead(row.entityId, args.actor);

      // Author-only: the caller's user id must match the comment's
      // author_id — for builders AND admins alike. Admins moderate via
      // soft-delete, never by rewriting someone else's words.
      if (row.authorId !== author.id) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You can only edit your own comments.',
          false,
        );
      }

      const updated = await comments.updateBody({
        id: row.id,
        body,
        updatedAt: clock(),
      });
      if (!updated) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Comment not found.', false);
      }
      return toContract(updated, author.name);
    },

    async deleteComment(args): Promise<{ readonly ok: true }> {
      // Admin-only entry point — the route is admin-gated; this is
      // defense in depth, not the authorization boundary.
      if (args.actor.kind !== 'admin') {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'Only admins can delete comments.',
          false,
        );
      }
      // The admin must resolve to a user row, like every other writer.
      await requireAuthor(args.actor.email);
      const row = await comments.getById(args.commentId);
      if (!row || row.deletedAt) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Comment not found.', false);
      }
      await requireVisibleLead(row.entityId, args.actor);
      await comments.softDelete({ id: row.id, deletedAt: clock() });
      return { ok: true };
    },
  };
}
