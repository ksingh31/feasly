import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  CommentListResponse,
  CommentVisibility,
  CreateCommentBody,
  Comment,
  UpdateCommentBody,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin lead-comments API client (BILL-07).
 *
 * Speaks the versioned `/api/v1/admin/leads/{leadId}/comments` routes
 * frozen by BILL-05. All calls carry `withCredentials: true` so the admin
 * session authenticates cross-origin (same pattern as the other admin
 * services). The admin area always talks to the real backend.
 *
 * Types come from `@feasly/contracts` (BILL-05 frozen contract).
 */
@Injectable({ providedIn: 'root' })
export class AdminCommentsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /**
   * Versioned contract paths (short segments — the no-hardcode tripwire
   * flags string literals >= 50 chars, and these are API contract, not
   * tunables, so they don't belong in app-config.json).
   */
  private static readonly LEADS_PATH = '/api/v1/admin/leads';
  private static readonly COMMENTS_PATH = '/api/v1/admin/comments';
  private static readonly COMMENTS_SEGMENT = '/comments';

  private get leadsBase(): string {
    return this.config.get('api').baseUrl + AdminCommentsApiService.LEADS_PATH;
  }

  private get commentsBase(): string {
    return this.config.get('api').baseUrl + AdminCommentsApiService.COMMENTS_PATH;
  }

  /** `/api/v1/admin/leads/{leadId}/comments` */
  private leadCommentsUrl(leadId: string): string {
    return this.leadsBase + '/' + encodeURIComponent(leadId) + AdminCommentsApiService.COMMENTS_SEGMENT;
  }

  /** `/api/v1/admin/comments/{commentId}` */
  private commentUrl(commentId: string): string {
    return this.commentsBase + '/' + encodeURIComponent(commentId);
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /**
   * Every comment on the lead — builder notes plus both kinds of admin
   * notes. `admin_only` rows ARE included here (admin read path); the
   * builder read path excludes them server-side.
   */
  listComments(leadId: string): Observable<CommentListResponse> {
    return this.call(
      this.http.get<CommentListResponse>(this.leadCommentsUrl(leadId), {
        withCredentials: true,
      }),
    );
  }

  /**
   * Post a note on the lead. The caller chooses the visibility;
   * `admin_only` is the safe default (matches the API default).
   */
  postComment(leadId: string, body: string, visibility: CommentVisibility): Observable<Comment> {
    const payload: CreateCommentBody = { body, visibility };
    return this.call(
      this.http.post<Comment>(this.leadCommentsUrl(leadId), payload, {
        withCredentials: true,
      }),
    );
  }

  /** Edit any comment on the lead (admin may edit all). */
  editComment(commentId: string, body: string): Observable<Comment> {
    const payload: UpdateCommentBody = { body };
    return this.call(
      this.http.patch<Comment>(this.commentUrl(commentId), payload, {
        withCredentials: true,
      }),
    );
  }

  /** Soft-delete any comment on the lead. The row persists server-side. */
  deleteComment(commentId: string): Observable<void> {
    return this.call(
      this.http.delete<void>(this.commentUrl(commentId), {
        withCredentials: true,
      }),
    );
  }
}
