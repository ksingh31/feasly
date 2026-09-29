/**
 * Thin builder comments route (BILL-05). Routes are adapters, not logic:
 * validate input → require builder session → call exactly one service
 * method → return the result.
 *
 * All endpoints are builder-gated via the session-cookie `BuilderGuard`.
 * The guard provides the session (email + tenantKey); the service scopes
 * every read/write to the session's builder. The builder path can never
 * see `admin_only` comments — the SQL excludes them.
 *
 * - `GET /api/v1/builder/leads/{leadId}/comments` — org-visible thread.
 * - `POST /api/v1/builder/leads/{leadId}/comments` — new comment
 *   (visibility forced to `org` server-side).
 * - `PATCH /api/v1/builder/comments/{commentId}` — author-only edit.
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
import type { BuilderGuard } from '../middleware/builder-guard';
import type {
  BuilderCommentsService,
  CommentActor,
} from '../services/builder-comments.service';

export interface BuilderCommentsRouteDeps {
  readonly comments: BuilderCommentsService;
  readonly builderGuard: BuilderGuard;
}

export interface BuilderCommentsRoute {
  /** GET /api/v1/builder/leads/{leadId}/comments */
  listLeadComments(
    headers: Record<string, string | string[] | undefined>,
    leadId: unknown,
  ): Promise<CommentListResponse>;
  /** POST /api/v1/builder/leads/{leadId}/comments */
  createLeadComment(
    headers: Record<string, string | string[] | undefined>,
    leadId: unknown,
    body: unknown,
  ): Promise<Comment>;
  /** PATCH /api/v1/builder/comments/{commentId} */
  updateComment(
    headers: Record<string, string | string[] | undefined>,
    commentId: unknown,
    body: unknown,
  ): Promise<Comment>;
}

const uuidSchema = z.string().trim().uuid();

function parseUuid(value: unknown, label: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, `Invalid ${label}.`, false);
  }
  return parsed.data;
}

async function requireBuilderActor(
  builderGuard: BuilderGuard,
  headers: Record<string, string | string[] | undefined>,
): Promise<CommentActor> {
  const session = await builderGuard.getBuilderSession(headers);
  if (!session) {
    throw new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'Builder authentication required.',
      false,
    );
  }
  return { kind: 'builder', email: session.email, tenantKey: session.tenantKey };
}

export function createBuilderCommentsRoute(
  deps: BuilderCommentsRouteDeps,
): BuilderCommentsRoute {
  const { comments, builderGuard } = deps;

  return {
    async listLeadComments(headers, leadId): Promise<CommentListResponse> {
      const actor = await requireBuilderActor(builderGuard, headers);
      return comments.listComments({
        entityType: 'lead',
        entityId: parseUuid(leadId, 'lead id'),
        actor,
      });
    },

    async createLeadComment(headers, leadId, body): Promise<Comment> {
      const actor = await requireBuilderActor(builderGuard, headers);
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
      const actor = await requireBuilderActor(builderGuard, headers);
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
  };
}
