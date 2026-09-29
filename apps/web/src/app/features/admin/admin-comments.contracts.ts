/**
 * Lead-comments contract — LOCAL COPY of the BILL-05 frozen contract.
 *
 * BILL-05 (`packages/contracts` + API) is being built on a parallel lane
 * and has not merged yet. This file mirrors its frozen shapes exactly so
 * the admin UI can build against them; when BILL-05 merges, delete this
 * file and import the same names from `@feasly/contracts` instead.
 * Do NOT drift these shapes — BILL-05 is the source of truth.
 */

/** Who can see a comment. `org` = visible to the lead's builder org; `admin_only` = internal. */
export type CommentVisibility = 'org' | 'admin_only';

/** Who wrote the comment. */
export type CommentAuthorKind = 'builder' | 'admin';

/**
 * Base comment shape (frozen by BILL-05). Builder and admin shapes derive
 * from this one base type — no duplicated interfaces.
 */
export interface LeadComment {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly authorKind: CommentAuthorKind;
  readonly authorId: string;
  readonly authorDisplayName: string;
  readonly visibility: CommentVisibility;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True once the comment has been edited after creation. */
  readonly edited: boolean;
}

/** `GET /api/v1/admin/leads/{leadId}/comments` response. */
export interface CommentListResponse {
  readonly comments: readonly LeadComment[];
}

/** `POST /api/v1/admin/leads/{leadId}/comments` request body. */
export interface CreateAdminCommentBody {
  readonly body: string;
  readonly visibility: CommentVisibility;
}

/** `PATCH /api/v1/admin/comments/{commentId}` request body. */
export interface UpdateCommentBody {
  readonly body: string;
}
