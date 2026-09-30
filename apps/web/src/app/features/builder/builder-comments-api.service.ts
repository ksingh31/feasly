import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  Comment,
  CommentListResponse,
  CreateCommentBody,
  UpdateCommentBody,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Builder lead-comments API client (BILL-06, wired to the real BILL-05
 * backend).
 *
 * Speaks the versioned `/api/v1/builder/leads/{leadId}/comments` routes
 * behind the builder session cookie (`withCredentials: true`). Every call
 * is tenant-scoped server-side: the builder read path excludes `admin_only`
 * notes, and edits are author-only (both enforced by the backend, never by
 * the UI).
 *
 * Types come from `@feasly/contracts` (BILL-05 frozen contract).
 */
@Injectable({ providedIn: 'root' })
export class BuilderCommentsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /**
   * Versioned contract paths (short segments — the no-hardcode tripwire
   * flags string literals >= 50 chars, and these are API contract, not
   * tunables, so they don't belong in app-config.json).
   */
  private static readonly LEADS_PATH = '/builder/leads';
  private static readonly COMMENTS_PATH = '/builder/comments';
  private static readonly COMMENTS_SEGMENT = '/comments';

  private get leadsBase(): string {
    const v1 = `${this.config.get('api').baseUrl}/api/v1`;
    return v1 + BuilderCommentsApiService.LEADS_PATH;
  }

  private get commentsBase(): string {
    const v1 = `${this.config.get('api').baseUrl}/api/v1`;
    return v1 + BuilderCommentsApiService.COMMENTS_PATH;
  }

  /** `/api/v1/builder/leads/{leadId}/comments` */
  private leadCommentsUrl(leadId: string): string {
    return (
      this.leadsBase +
      '/' +
      encodeURIComponent(leadId) +
      BuilderCommentsApiService.COMMENTS_SEGMENT
    );
  }

  /** `/api/v1/builder/comments/{commentId}` */
  private commentUrl(commentId: string): string {
    return this.commentsBase + '/' + encodeURIComponent(commentId);
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /**
   * Org-visible thread for the lead, oldest first. `admin_only` notes are
   * excluded server-side — builders can never see them through this path.
   */
  listComments(leadId: string): Observable<CommentListResponse> {
    return this.call(
      this.http.get<CommentListResponse>(this.leadCommentsUrl(leadId), {
        withCredentials: true,
      }),
    );
  }

  /**
   * Post a note as the current builder user. The backend derives the author
   * from the session and forces `visibility: 'org'` — no visibility choice
   * is sent (or accepted) on the builder path.
   */
  postComment(leadId: string, body: string): Observable<Comment> {
    const payload: CreateCommentBody = { body };
    return this.call(
      this.http.post<Comment>(this.leadCommentsUrl(leadId), payload, {
        withCredentials: true,
      }),
    );
  }

  /** Edit an own comment. Author-only is enforced server-side. */
  editComment(commentId: string, body: string): Observable<Comment> {
    const payload: UpdateCommentBody = { body };
    return this.call(
      this.http.patch<Comment>(this.commentUrl(commentId), payload, {
        withCredentials: true,
      }),
    );
  }
}
