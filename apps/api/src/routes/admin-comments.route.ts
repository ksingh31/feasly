/**
 * Thin admin comments route (BILL-05). Routes are adapters, not logic:
 * validate input → require admin auth → call exactly one service method
 * → return the result.
 *
 * All endpoints are admin-gated via the Entra `AdminGuard`. The admin
 * read path includes `admin_only` rows; the admin write path defaults
 * new comments to `admin_only` (the composer default) unless `org` is
 * explicitly requested. Admins soft-delete via DELETE — the row survives
 * in the database, both read paths exclude it in SQL.
 *
 * - `GET /api/v1/admin/leads/{leadId}/comments` — full thread.
 * - `POST /api/v1/admin/leads/{leadId}/comments` — new comment
 *   (default visibility `admin_only`).
 * - `PATCH /api/v1/admin/comments/{commentId}` — author-only edit.
 * - `DELETE /api/v1/admin/comments/{commentId}` — soft delete.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  Comment,
  CommentListResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type {
  BuilderCommentsService,
  CommentActor,
} from '../services/builder-comments.service';

export interface AdminCommentsRouteDeps {
  readonly comments: BuilderCommentsService;
  readonly adminGuard: AdminGuard;
}

export interface AdminCommentsRoute {
  /** GET /api/v1/admin/leads/{leadId}/comments */
  listLeadComments(
    headers: Record<string, string | string[] | undefined>,
    leadId: unknown,
  ): Promise<CommentListResponse>;
  /** POST /api/v1/admin/leads/{leadId}/comments */
  createLeadComment(
    headers: Record<string, string | string[] | undefined>,
    leadId: unknown,
    body: unknown,
  ): Promise<Comment>;
  /** PATCH /api/v1/admin/comments/{commentId} */
  updateComment(
    headers: Record<string, string | string[] | undefined>,
    commentId: unknown,
    body: unknown,
  ): Promise<Comment>;
  /** DELETE /api/v1/admin/comments/{commentId} — soft delete. */
  deleteComment(
    headers: Record<string, string | string[] | undefined>,
    commentId: unknown,
  ): Promise<{ readonly ok: true }>;
}

const uuidSchema = z.string().trim().uuid();

function parseUuid(value: unknown, label: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, `Invalid ${label}.`, false);
  }
  return parsed.data;
}

async function requireAdminActor(
  adminGuard: AdminGuard,
  headers: Record<string, string | string[] | undefined>,
): Promise<CommentActor> {
  await adminGuard.requireAdmin(headers);
  const email = await adminGuard.getAdminEmail(headers);
  if (!email) {
    throw new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'Admin authentication required.',
      false,
    );
  }
  return { kind: 'admin', email };
}

export function createAdminCommentsRoute(
  deps: AdminCommentsRouteDeps,
): AdminCommentsRoute {
  const { comments, adminGuard } = deps;

  return {
    async listLeadComments(headers, leadId): Promise<CommentListResponse> {
      const actor = await requireAdminActor(adminGuard, headers);
      return comments.listComments({
        entityType: 'lead',
        entityId: parseUuid(leadId, 'lead id'),
        actor,
      });
    },

    async createLeadComment(headers, leadId, body): Promise<Comment> {
      const actor = await requireAdminActor(adminGuard, headers);
      const parsed = z
        .object({ body: z.unknown(), visibility: z.unknown().optional() })
        .safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid comment body.',
          false,
        );
      }
      return comments.createComment({
        entityType: 'lead',
        entityId: parseUuid(leadId, 'lead id'),
        body: parsed.data.body,
        visibility: parsed.data.visibility,
        actor,
      });
    },

    async updateComment(headers, commentId, body): Promise<Comment> {
      const actor = await requireAdminActor(adminGuard, headers);
      const parsed = z.object({ body: z.unknown() }).safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid comment body.',
          false,
        );
      }
      return comments.updateComment({
        commentId: parseUuid(commentId, 'comment id'),
        body: parsed.data.body,
        actor,
      });
    },

    async deleteComment(
      headers,
      commentId,
    ): Promise<{ readonly ok: true }> {
      const actor = await requireAdminActor(adminGuard, headers);
      return comments.deleteComment({
        commentId: parseUuid(commentId, 'comment id'),
        actor,
      });
    },
  };
}
